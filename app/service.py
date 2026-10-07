from __future__ import annotations

import asyncio
import copy
import secrets
import string
import uuid
from datetime import datetime, timezone

from .matching import match_items
from .media import MediaClient, MediaError
from .store import Store


class ServiceError(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def generate_password() -> str:
    # Guarantee categories while retaining over 100 bits of random entropy.
    chars = [secrets.choice(string.ascii_uppercase), secrets.choice(string.ascii_lowercase), secrets.choice(string.digits), secrets.choice("!@#%+_-")]
    chars += [secrets.choice(string.ascii_letters + string.digits + "!@#%+_-") for _ in range(20)]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def validate_username(username: str) -> str:
    if not username or username != username.strip() or len(username) > 64 or any(ord(c) < 32 for c in username) or any(c in username for c in "\\/<>"):
        raise ServiceError("Use a username of 1–64 characters without leading/trailing spaces, control characters, slashes or angle brackets.")
    return username


def template_policy(template: dict) -> dict:
    policy = copy.deepcopy(template.get("Policy") or {})
    if not policy or policy.get("IsAdministrator") or policy.get("IsDisabled"):
        raise ServiceError("Choose an enabled, non-administrator Jellyfin template user.")
    for key in ("InvalidLoginAttemptCount", "LoginAttemptsBeforeLockout", "FailedLoginAttempts"):
        if key != "LoginAttemptsBeforeLockout":
            policy.pop(key, None)
    return policy


class Service:
    def __init__(self, store: Store, client_factory=MediaClient, demo=False):
        self.store = store
        self.client_factory = client_factory
        self.demo = demo
        self.bot = None
        self.lock = asyncio.Lock()
        self.tasks: set[asyncio.Task] = set()
        self.job_tasks: dict[str, asyncio.Task] = {}
        self.subscription_lock = asyncio.Lock()

    def client(self, settings: dict, kind: str):
        self._require_server(settings, kind)
        return self.client_factory(settings[f"{kind}_url"], settings[f"{kind}_api_key"], kind=kind)

    @staticmethod
    def _require_server(settings: dict, kind: str):
        if not settings.get(f"{kind}_url") or not settings.get(f"{kind}_api_key"):
            raise ServiceError(f"Configure the {kind.title()} server URL and API key in Settings first.")

    async def users(self) -> dict:
        settings = self.store.settings()
        async def fetch(kind):
            if settings.get(f"{kind}_url") and settings.get(f"{kind}_api_key"):
                try:
                    async with self.client(settings, kind) as client:
                        return await client.users(), None
                except (MediaError, ServiceError) as error:
                    return [], str(error)
            return [], None
        emby, jellyfin = await asyncio.gather(fetch("emby"), fetch("jellyfin"))
        errors = {kind: result[1] for kind, result in (("emby", emby), ("jellyfin", jellyfin)) if result[1]}
        return {"emby": emby[0], "jellyfin": jellyfin[0], "errors": errors}

    async def emby_users(self) -> list[dict]:
        settings = self.store.settings()
        async with self.client(settings, "emby") as client:
            return await client.users()

    async def connections(self) -> dict:
        settings = self.store.settings()
        async def check(kind):
            configured = bool(settings.get(f"{kind}_url") and settings.get(f"{kind}_api_key"))
            result = {"configured": configured, "connected": False}
            if configured:
                try:
                    async with self.client(settings, kind) as client:
                        info = await client.system_info()
                        # Public server info alone cannot validate an API key.
                        await client.users()
                    result.update(connected=True, name=info.get("ServerName", kind.title()), version=info.get("Version", ""))
                except (MediaError, ServiceError):
                    result["error"] = f"Unable to authenticate to {kind.title()}. Check URL, API key and network access."
            return result
        emby, jellyfin = await asyncio.gather(check("emby"), check("jellyfin"))
        return {"emby": emby, "jellyfin": jellyfin, "discord": self.bot.status() if self.bot else {"enabled": False, "connected": False}}

    async def _template(self, client, settings):
        if not settings.get("template_user_id"):
            raise ServiceError("Select your Jellyfin template user in Settings first.")
        template = await client.user(settings["template_user_id"])
        template_policy(template)
        return template

    @staticmethod
    def _target(users, username):
        matches = [u for u in users if u["Name"].casefold() == username.casefold()]
        if len(matches) > 1:
            raise ServiceError("Multiple Jellyfin accounts match this username. Resolve the duplicate before continuing.")
        target = matches[0] if matches else None
        if target and target["Name"] != username:
            raise ServiceError("A Jellyfin username differs only by letter case. Resolve it first so usernames can match exactly.")
        return target

    @staticmethod
    def _plan(source, target, mappings):
        played = [i for i in source if (i.get("UserData") or {}).get("Played") is True]
        matched = match_items(played, target, mappings)
        already = sum(bool((m["target"].get("UserData") or {}).get("Played")) for m in matched["matches"])
        return matched, {"source_played": len(played), "matched": len(matched["matches"]), "unmatched": len(matched["unmatched"]), "ambiguous": len(matched["ambiguous"]), "already_played": already}

    async def preview(self, source_user_ids: list[str]) -> dict:
        settings = self.store.settings()
        async with self.client(settings, "emby") as emby, self.client(settings, "jellyfin") as jellyfin:
            template = await self._template(jellyfin, settings)
            targets = await jellyfin.users()
            users = []
            for source_id in source_user_ids:
                source_user = await emby.user(source_id)
                username = validate_username(source_user["Name"])
                target = self._target(targets, username)
                if target and (target["Id"] == template["Id"] or (target.get("Policy") or {}).get("IsAdministrator")):
                    raise ServiceError("A migration cannot target your template user or a Jellyfin administrator.")
                source = await emby.items(source_id)
                target_items = await jellyfin.items(target["Id"] if target else template["Id"])
                if not target:
                    # Template controls visibility and permissions, never initial watch history.
                    target_items = [item | {"UserData": {"Played": False}} for item in target_items]
                plan, stats = self._plan(source, target_items, settings["path_mappings"])
                users.append({"source_user_id": source_id, "username": username, "target_user_id": target["Id"] if target else None, "target_exists": bool(target), "stats": stats, "unmatched": plan["unmatched"], "ambiguous": plan["ambiguous"]})
        return {"users": users, "mode": "merge"}

    async def _validate_recipients(self, recipients):
        for recipient in set(recipients):
            if not self.bot:
                raise ServiceError("Enable and connect the Discord bot before selecting a recipient.")
            try:
                await self.bot.validate_recipient(str(recipient))
            except Exception:
                raise ServiceError("Discord recipient is unavailable or does not have the required membership role.") from None

    async def create_account(self, username: str, discord_user_id=None) -> dict:
        validate_username(username)
        if discord_user_id:
            await self._validate_recipients([discord_user_id])
            identity = await self.bot.recipient_identity(str(discord_user_id))
            if username != identity["username"]:
                raise ServiceError("Use the recipient's Discord username, not their server nickname or display name.")
        self._require_server(self.store.settings(), "jellyfin")
        return self._queue("create", [{"username": username, "discord_user_id": discord_user_id}])

    async def recovery_info(self, username: str) -> dict:
        validate_username(username)
        local = self.store.account(username)
        settings = self.store.settings()
        async with self.client(settings, "jellyfin") as jellyfin:
            target = self._target(await jellyfin.users(), username)
        eligible = bool(local and local["status"] in {"uncertain", "provisioning"} and target and (not local["remote_id"] or local["remote_id"] == target["Id"]) and target["Id"] != settings["template_user_id"] and not (target.get("Policy") or {}).get("IsAdministrator"))
        return {"username": username, "target_exists": bool(target), "target_user_id": target["Id"] if target else None, "eligible": eligible, "reason": "Inspect this Jellyfin account. Recovery will reset its password and apply your template; watch history is preserved." if eligible else "Recovery is available only for an incomplete Jellyport creation with an existing, unprotected Jellyfin account."}

    async def recover_account(self, username: str, target_user_id: str, discord_user_id=None) -> dict:
        info = await self.recovery_info(username)
        if not info["eligible"] or info["target_user_id"] != target_user_id:
            raise ServiceError("The inspected recovery target is no longer eligible. Refresh its details before proceeding.")
        if discord_user_id:
            await self._validate_recipients([discord_user_id])
            identity = await self.bot.recipient_identity(str(discord_user_id))
            if identity["username"] != username:
                raise ServiceError("Use the recipient's Discord username when recovering and linking an account.")
        return self._queue("recover", [{"username": username, "discord_user_id": discord_user_id, "recover_target_id": target_user_id}])

    async def migrate_users(self, source_user_ids, discord_recipients=None) -> dict:
        if not source_user_ids or len(source_user_ids) > 100 or len(set(source_user_ids)) != len(source_user_ids):
            raise ServiceError("Select 1–100 distinct Emby users.")
        discord_recipients = discord_recipients or {}
        if set(discord_recipients) - set(source_user_ids):
            raise ServiceError("A Discord recipient must belong to a selected source user.")
        if len(set(discord_recipients.values())) != len(discord_recipients):
            raise ServiceError("Choose a different Discord recipient for each account.")
        await self._validate_recipients(discord_recipients.values())
        self._require_server(self.store.settings(), "emby")
        self._require_server(self.store.settings(), "jellyfin")
        return self._queue("migrate", [{"source_user_id": uid, "discord_user_id": discord_recipients.get(uid)} for uid in source_user_ids])

    def _queue(self, kind, requests):
        timestamp = now()
        job = {"id": uuid.uuid4().hex, "kind": kind, "status": "queued", "created_at": timestamp, "updated_at": timestamp, "progress": {"processed": 0, "total": len(requests)}, "results": []}
        self.store.save_job(job)
        settings = self.store.settings()
        task = asyncio.create_task(self._run(job, requests, settings))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.job_tasks[job["id"]] = task
        task.add_done_callback(lambda _: self.job_tasks.pop(job["id"], None))
        return copy.deepcopy(job)

    def get_job(self, job_id):
        job = self.store.job(job_id)
        if not job:
            raise ServiceError("Job not found.")
        return job

    def _save(self, job):
        job["updated_at"] = now()
        self.store.save_job(job)

    async def _provision(self, jellyfin, settings, template, username, allow_existing, recover_target_id=None):
        target = self._target(await jellyfin.users(), username)
        local = self.store.account(username)
        if target and target["Id"] == template["Id"]:
            raise ServiceError("The template account cannot be a destination account.")
        if target and (target.get("Policy") or {}).get("IsAdministrator"):
            raise ServiceError("A Jellyfin administrator cannot be a destination account.")
        password = None
        if recover_target_id:
            if not target or target["Id"] != recover_target_id or not local or local["status"] not in {"uncertain", "provisioning"} or (local["remote_id"] and local["remote_id"] != target["Id"]):
                raise ServiceError("Recovery target changed. Inspect the account again; no password was reset.")
            password = generate_password()
            self.store.save_account(username, target["Id"], "provisioning", password)
            await jellyfin.set_password(target["Id"], password)
        if target:
            if recover_target_id:
                pass
            elif local and local["remote_id"] == target["Id"] and local["status"] == "provisioning":
                password = self.store.account_password(local) or generate_password()
                await jellyfin.set_password(target["Id"], password)
            elif allow_existing:
                return target, False, None
            else:
                raise ServiceError("This Jellyfin username already exists. Its password and permissions were preserved. Use migration to merge watch history.")
        else:
            if local and local["status"] == "uncertain":
                raise ServiceError("An earlier creation request had an uncertain outcome. Inspect Jellyfin before retrying this username.")
            password = generate_password()
            self.store.save_account(username, None, "provisioning", password)
            try:
                target = await jellyfin.create_user(username, password)
            except MediaError as error:
                if error.status_code in {401, 403}:
                    self.store.save_account(username, None, "rejected")
                    raise
                self.store.save_account(username, None, "uncertain")
                raise ServiceError("Account creation outcome is uncertain. Inspect Jellyfin before retrying; no password was reset.") from None
            except Exception:
                self.store.save_account(username, None, "uncertain")
                raise ServiceError("Account creation outcome is uncertain. Inspect Jellyfin before retrying; no password was reset.") from None
            self.store.save_account(username, target["Id"], "provisioning", password)
        await jellyfin.set_policy(target["Id"], template_policy(template))
        await jellyfin.set_configuration(target["Id"], copy.deepcopy(template.get("Configuration") or {}))
        return target, True, password

    async def _one(self, job, request, settings, jellyfin, template):
        source_id = request.get("source_user_id")
        source_items = None
        if source_id:
            async with self.client(settings, "emby") as emby:
                source_user = await emby.user(source_id)
                username = validate_username(source_user["Name"])
                # Read source before account creation; failed reads should not provision accounts.
                source_items = await emby.items(source_id)
        else:
            username = request["username"]
        recipient = request.get("discord_user_id")
        if recipient:
            identity = await self.bot.recipient_identity(str(recipient))
            link = self.store.link(str(recipient))
            if link and link["username"] != username:
                raise ServiceError("This Discord user is already linked to a different Jellyfin account. Existing identity link was preserved.")
            if not link and username != identity["username"]:
                raise ServiceError("The Emby username must match this recipient's Discord username when first linking an account.")
        result = {"username": username, "status": "running", "created": False, "applied": 0, "matched": 0, "unmatched": 0, "ambiguous": 0, "already_played": 0, "discord_delivery": "not_requested"}
        job["results"].append(result)
        self._save(job)
        try:
            target, created, password = await self._provision(jellyfin, settings, template, username, bool(source_id), request.get("recover_target_id"))
            result.update(created=created, target_user_id=target["Id"])
            if recipient:
                existing_link = self.store.link_for_remote(target["Id"])
                if existing_link and existing_link["discord_user_id"] != str(recipient):
                    raise ServiceError("This Jellyfin account is already linked to another Discord user.")
                previous = self.store.link(str(recipient))
                self.store.save_link(str(recipient), username, target["Id"], bool(previous and previous["disabled_by_jellyport"]))
            public_url = settings["jellyfin_public_url"] or settings["jellyfin_url"]
            if password:
                self.store.save_credentials(job["id"], username, password, public_url)
                self.store.save_account(username, target["Id"], "ready")
            if source_items is not None:
                target_items = await jellyfin.items(target["Id"])
                plan, stats = self._plan(source_items, target_items, settings["path_mappings"])
                result.update(stats)
                result["unmatched_items"] = [{"name": i.get("Name", ""), "type": i.get("Type", ""), "id": i.get("Id")} for i in plan["unmatched"]]
                result["ambiguous_items"] = [{"name": i["source"].get("Name", ""), "id": i["source"].get("Id"), "candidate_ids": [c["Id"] for c in i["candidates"]]} for i in plan["ambiguous"]]
                self._save(job)
                for match in plan["matches"]:
                    if not (match["target"].get("UserData") or {}).get("Played"):
                        await jellyfin.mark_played(target["Id"], match["target"]["Id"])
                        result["applied"] += 1
                        if result["applied"] % 20 == 0:
                            self._save(job)
            if recipient and password:
                try:
                    # Re-check live membership immediately before sending secrets.
                    await self.bot.validate_recipient(str(recipient))
                    await self.bot.deliver(str(recipient), username, password, public_url)
                    result["discord_delivery"] = "sent"
                    self.store.delete_credentials(job["id"], username)
                except Exception:
                    result["discord_delivery"] = "failed"
                    result["delivery_error"] = "Discord delivery failed. Credentials remain available for one-time reveal for 24 hours."
            elif recipient:
                result["discord_delivery"] = "skipped_existing_account"
            result["status"] = "partial" if result["unmatched"] or result["ambiguous"] or result["discord_delivery"] == "failed" else "completed"
        except (MediaError, ServiceError) as error:
            result.update(status="failed", error=str(error))
        except Exception:
            result.update(status="failed", error="This account could not be completed. Review server connectivity and run again; existing passwords are preserved.")
        self._save(job)

    async def _run(self, job, requests, settings):
        async with self.lock:
            job["status"] = "running"
            self._save(job)
            try:
                async with self.client(settings, "jellyfin") as jellyfin:
                    template = await self._template(jellyfin, settings)
                    for request in requests:
                        try:
                            await self._one(job, request, settings, jellyfin, template)
                        except (MediaError, ServiceError) as error:
                            job["results"].append({"username": request.get("username", request.get("source_user_id", "")), "status": "failed", "error": str(error)})
                        job["progress"]["processed"] += 1
                        self._save(job)
                statuses = [r["status"] for r in job["results"]]
                job["status"] = "completed" if all(s == "completed" for s in statuses) else "failed" if all(s == "failed" for s in statuses) else "partial"
            except (MediaError, ServiceError) as error:
                job.update(status="failed", error=str(error))
            except asyncio.CancelledError:
                job.update(status="interrupted", error="App stopped during this job. Run again to resume watch-state merging.")
                raise
            except Exception:
                job.update(status="failed", error="Job failed unexpectedly. Check configuration and server availability.")
            finally:
                self._save(job)

    async def stop(self):
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    async def record_subscription(self, incoming: dict) -> dict:
        """Only called by the configured Discord bot; not a public HTTP ingress."""
        event_id = str(incoming["id"])
        existing = self.store.subscription(event_id)
        if existing:
            return existing
        event = {key: incoming.get(key) for key in ("action", "username", "discord_user_id", "source", "detail", "emitted_at")}
        event.update(id=event_id, status="pending", created_at=now())
        if event["action"] not in {"subscribe", "cancel", "expire"}:
            raise ServiceError("Unknown subscription action.")
        self.store.save_subscription(event)
        settings = self.store.settings()
        auto = settings["auto_provision"] if event["action"] == "subscribe" else settings["auto_disable"] and (event["action"] == "expire" or settings["disable_on_cancel"])
        if auto and event["discord_user_id"]:
            try:
                await self.apply_subscription(event_id, automatic=True)
            except ServiceError:
                pass  # Error is recorded for administrator review.
        return self.store.subscription(event_id)

    async def apply_subscription(self, event_id: str, automatic=False) -> dict:
        async with self.subscription_lock:
            event = self.store.subscription(event_id)
            if not event:
                raise ServiceError("Subscription event not found.")
            if event["status"] in {"applied", "ignored", "processing"}:
                return event
            if not event.get("discord_user_id"):
                raise ServiceError("This message could not be resolved to one Discord user ID. Use a manual account action after verifying the member.")
            event.update(status="processing", error=None)
            self.store.save_subscription(event)
            try:
                member_id = str(event["discord_user_id"])
                settings = self.store.settings()
                link = self.store.link(member_id)
                identity = await self.bot.recipient_identity(member_id) if event["action"] == "subscribe" else None
                if event["action"] == "expire" and event["source"] in {"discord_role", "role_reconciliation"}:
                    active = await self.bot.membership_active(member_id)
                    if active is None:
                        raise ServiceError("Membership could not be verified. No account was disabled.")
                    if active:
                        event.update(status="ignored", result="Member currently has the active role; obsolete expiration event ignored.")
                        self.store.save_subscription(event)
                        return event
                if event["action"] == "subscribe" and not link:
                    # A username alone does not prove ownership of a pre-existing account.
                    async with self.client(settings, "jellyfin") as jellyfin:
                        target = self._target(await jellyfin.users(), identity["username"])
                        if target:
                            raise ServiceError("A Jellyfin account already exists without a Discord identity link. Link it through an admin-approved migration first.")
                    sources = []
                    if settings["emby_url"] and settings["emby_api_key"]:
                        sources = [u for u in await self.emby_users() if u["Name"] == identity["username"]]
                    if len(sources) > 1:
                        raise ServiceError("More than one Emby account matches this username.")
                    if sources:
                        job = await self.migrate_users([sources[0]["Id"]], {sources[0]["Id"]: member_id})
                    else:
                        job = await self.create_account(identity["username"], member_id)
                    event["job_id"] = job["id"]
                    # Wait for this queued action before allowing a later expiry to disable it.
                    task = self.job_tasks.get(job["id"])
                    if task:
                        await task
                    final_job = self.get_job(job["id"])
                    if final_job["status"] == "failed":
                        raise ServiceError("Account provisioning failed. Review the linked job.")
                else:
                    if not link:
                        raise ServiceError("This Discord member has no Jellyport identity link. No account was disabled.")
                    async with self.lock:
                        async with self.client(settings, "jellyfin") as jellyfin:
                            target = await jellyfin.user(link["remote_id"])
                            policy = copy.deepcopy(target.get("Policy") or {})
                            if not policy or policy.get("IsAdministrator") or target["Id"] == settings["template_user_id"] or target["Name"] != link["username"]:
                                raise ServiceError("The linked account changed or is protected. Review it manually.")
                            disabled = bool(policy.get("IsDisabled"))
                            # Reconcile a policy mutation that succeeded remotely but timed out.
                            pending = link.get("pending_disabled")
                            if pending is not None and disabled == bool(pending):
                                self.store.save_link(member_id, link["username"], target["Id"], disabled)
                                link = self.store.link(member_id)
                            if event["action"] == "subscribe":
                                if link["disabled_by_jellyport"] and disabled:
                                    policy["IsDisabled"] = False
                                    await self._set_access(jellyfin, target["Id"], policy, member_id, False)
                                    self.store.save_link(member_id, link["username"], target["Id"], False)
                                elif not disabled:
                                    self.store.save_link(member_id, link["username"], target["Id"], False)
                            elif not disabled:
                                policy["IsDisabled"] = True
                                await self._set_access(jellyfin, target["Id"], policy, member_id, True)
                                self.store.save_link(member_id, link["username"], target["Id"], True)
                    event["result"] = "Account access updated; password and watch history preserved."
                event["status"] = "applied"
            except (ServiceError, MediaError) as error:
                event.update(status="failed", error=str(error))
                self.store.save_subscription(event)
                raise ServiceError(str(error)) from None
            except Exception:
                event.update(status="failed", error="Subscription action failed. Check bot connectivity and account links.")
                self.store.save_subscription(event)
                raise ServiceError(event["error"]) from None
            self.store.save_subscription(event)
            return event

    def ignore_subscription(self, event_id):
        event = self.store.subscription(event_id)
        if not event:
            raise ServiceError("Subscription event not found.")
        if event["status"] == "processing":
            raise ServiceError("Wait for this subscription action to finish.")
        event["status"] = "ignored"
        self.store.save_subscription(event)
        return event

    async def _set_access(self, client, remote_id, policy, member_id, disabled):
        self.store.set_link_pending(member_id, disabled)
        try:
            await client.set_policy(remote_id, policy)
        except MediaError as error:
            if error.status_code is not None and 400 <= error.status_code < 500:
                # A definite rejection did not change policy; retain no ownership claim.
                self.store.set_link_pending(member_id, None)
            raise

    async def reconcile_memberships(self):
        """Catch role changes missed while offline, using only explicit identity links."""
        settings = self.store.settings()
        if not settings["discord_role_events"] or not settings["discord_member_role_id"]:
            return
        for link in self.store.links():
            active = await self.bot.membership_active(link["discord_user_id"])
            if active is None:
                continue
            action = "subscribe" if active else "expire"
            if active and not link["disabled_by_jellyport"]:
                continue
            # One event per observed state; don't repeatedly add pending events.
            existing = next((e for e in self.store.subscriptions() if e.get("source") == "role_reconciliation" and e.get("discord_user_id") == link["discord_user_id"] and e["action"] == action and e["status"] in {"pending", "processing"}), None)
            if existing:
                continue
            if not active and link["disabled_by_jellyport"]:
                continue
            await self.record_subscription({"id": f"reconcile-{uuid.uuid4().hex}", "action": action, "discord_user_id": link["discord_user_id"], "username": link["username"], "source": "role_reconciliation", "emitted_at": now()})
        if settings["auto_provision"]:
            members = await self.bot.active_members()
            if members is None:
                return
            for member in members:
                if self.store.link(member["id"]):
                    continue
                # Failed or pending scans remain available for explicit review, not auto retry.
                if any(e.get("source") == "role_reconciliation" and e.get("discord_user_id") == member["id"] and e["action"] == "subscribe" and e["status"] != "ignored" for e in self.store.subscriptions()):
                    continue
                await self.record_subscription({"id": f"reconcile-{uuid.uuid4().hex}", "action": "subscribe", "discord_user_id": member["id"], "username": member["username"], "source": "role_reconciliation", "emitted_at": now()})
