"""Optional Discord gateway bot. Credentials are sent only by explicit delivery calls."""

from __future__ import annotations

import asyncio
import contextlib
import re
import unicodedata
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping
from datetime import datetime, timezone
from typing import Any, Protocol
from urllib.parse import urlsplit

import discord
from discord import app_commands


class BotError(ValueError):
    """A fixed, public error message, safe to display without library details."""


class MigrationService(Protocol):
    async def create_account(self, username: str, discord_user_id: str | None = None) -> dict: ...

    async def migrate_users(
        self, source_user_ids: list[str], discord_recipients: dict[str, str] | None = None
    ) -> dict: ...

    async def emby_users(self) -> list[dict]: ...

    def get_job(self, job_id: str) -> dict: ...

    async def record_subscription(self, event: dict[str, Any]) -> Any: ...


def _snowflake(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]{1,20}", value):
        result = int(value)
    else:
        return None
    return result if 0 < result < 2**64 else None


def command_authorized(
    guild_id: Any,
    configured_guild_id: Any,
    *,
    administrator: bool,
    role_ids: Iterable[Any],
    admin_role_id: Any = None,
) -> bool:
    """Discord command visibility is a hint; enforce our own server and role rules."""
    configured = _snowflake(configured_guild_id)
    if configured is None or _snowflake(guild_id) != configured:
        return False
    role = _snowflake(admin_role_id)
    return bool(administrator) or (role is not None and role in {_snowflake(r) for r in role_ids})


def recipient_eligible(
    guild_id: Any,
    configured_guild_id: Any,
    *,
    bot: bool,
    role_ids: Iterable[Any],
    member_role_id: Any = None,
) -> bool:
    configured = _snowflake(configured_guild_id)
    if bot or configured is None or _snowflake(guild_id) != configured:
        return False
    if member_role_id in (None, ""):
        return True
    role = _snowflake(member_role_id)
    return role is not None and role in {_snowflake(r) for r in role_ids}


_SUBSCRIBER = r"(?P<recipient><@!?[0-9]{1,20}>|@?[A-Za-z0-9_.]{1,32})"
_SUBSCRIBED = re.compile(
    r"Good[ \t]+news[ \t]+captain![ \t]+" + _SUBSCRIBER
    + r"[ \t]+just[ \t]+subscribed[ \t]+to[ \t]+(?P<plan>[^\r\n!]{1,100})![ \t]*",
    re.IGNORECASE,
)
_CANCELLED = re.compile(
    r"Bad[ \t]+news[ \t]+captain![ \t]+" + _SUBSCRIBER
    + r"[ \t]+just[ \t]+cancel(?:led|ed)[ \t]+their[ \t]+subscription\.[ \t]*",
    re.IGNORECASE,
)


def parse_subscription_message(content: str) -> dict[str, Any] | None:
    """Recognize only the owner's two MEE6 templates; never infer an expiry."""
    if not isinstance(content, str) or len(content) > 300 or "\n" in content or "\r" in content:
        return None
    match = _SUBSCRIBED.fullmatch(content.strip())
    action = "subscribe"
    if match is None:
        match = _CANCELLED.fullmatch(content.strip())
        action = "cancel"
    if match is None:
        return None
    recipient = match.group("recipient")
    mention = re.fullmatch(r"<@!?([0-9]{1,20})>", recipient)
    user_id = _snowflake(mention[1]) if mention else None
    if mention and user_id is None:
        return None
    return {
        "action": action,
        "discord_user_id": str(user_id) if user_id else None,
        "username": None if mention else recipient.removeprefix("@"),
        "detail": match.group("plan").strip() if action == "subscribe" else "Cancellation announcement; paid access may remain active.",
    }


def _credential_text(value: str, maximum: int) -> str:
    # Escaping Markdown preserves its rendered value and prevents a username or
    # password from creating a link, heading, code block, or formatting span.
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise BotError("Credentials could not be formatted for delivery.")
    if any(unicodedata.category(ch).startswith("C") for ch in value):
        raise BotError("Credentials could not be formatted for delivery.")
    return discord.utils.escape_markdown(value, as_needed=False, ignore_links=False)


def credential_message(username: str, password: str, server_url: str) -> str:
    try:
        parsed = urlsplit(server_url)
        valid_url = (
            isinstance(server_url, str)
            and parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and len(server_url) <= 1000
            and not any(ch.isspace() or ch in "<>" or unicodedata.category(ch).startswith("C") for ch in server_url)
        )
    except (TypeError, ValueError):
        valid_url = False
    if not valid_url:
        raise BotError("Configure a valid public Jellyfin URL before sending credentials.")
    message = (
        "Your Jellyfin account is ready.\n\n"
        f"Server: <{server_url}>\n"
        f"Username: {_credential_text(username, 256)}\n"
        f"Password: {_credential_text(password, 512)}\n\n"
        "Keep these credentials private. You can change your password in Jellyfin."
    )
    if len(message) > 1900:
        raise BotError("Credentials could not be formatted for delivery.")
    return message


def job_status_message(job: Mapping[str, Any]) -> str:
    """Whitelist fields: job records may contain passwords and upstream errors."""
    job_id = str(job.get("id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job_id):
        return "Job accepted. Check its progress in the Jellyport web page."
    state = job.get("status", job.get("state", "queued"))
    if state not in {"queued", "running", "completed", "partial", "failed", "cancelled", "interrupted"}:
        state = "unknown"
    message = f"Job `{job_id}`: {state}."
    progress = job.get("progress")
    progress = progress if isinstance(progress, Mapping) else job
    processed, total = progress.get("processed"), progress.get("total")
    if isinstance(processed, int) and not isinstance(processed, bool) and isinstance(total, int) and not isinstance(total, bool):
        if 0 <= processed <= total:
            message += f" {processed}/{total} users processed."
    return message


class _Commands(app_commands.Group):
    def __init__(self, manager: BotManager):
        super().__init__(
            name="jellyport",
            description="Create Jellyfin accounts and migrate Emby users",
            guild_only=True,
            default_permissions=discord.Permissions(administrator=True),
        )
        self.manager = manager

    @app_commands.command(name="create", description="Create an account and privately send its credentials")
    @app_commands.describe(user="Current server member receiving the credentials", username="Optional confirmation of the recipient's Discord username")
    async def create(self, interaction: discord.Interaction, user: discord.Member, username: str | None = None):
        await self.manager._dispatch_event(interaction.client, self.manager.handle_create, interaction, user, username)

    @app_commands.command(name="migrate", description="Migrate an Emby user and privately send new account credentials")
    @app_commands.describe(user="Current server member receiving the credentials", emby_username="Exact Emby username")
    async def migrate(self, interaction: discord.Interaction, user: discord.Member, emby_username: str | None = None):
        await self.manager._dispatch_event(interaction.client, self.manager.handle_migrate, interaction, user, emby_username)

    @app_commands.command(name="status", description="Check the progress of a Jellyport job")
    async def status(self, interaction: discord.Interaction, job_id: str):
        await self.manager._dispatch_event(interaction.client, self.manager.handle_status, interaction, job_id)

    async def on_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
        await self.manager._reply(interaction, "The command could not be completed. Check the Jellyport web page.")


class _Client(discord.Client):
    def __init__(self, manager: BotManager, guild_id: int):
        intents = discord.Intents.none()
        intents.guilds = True
        if manager._settings.get("discord_message_events"):
            intents.guild_messages = True
            intents.message_content = True
            # Plain cancellation usernames require an exact, fresh member lookup.
            intents.members = True
        if manager._settings.get("discord_role_events"):
            intents.members = True
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.manager = manager
        self.guild_id = guild_id
        self._reconciling = False
        self.tree = app_commands.CommandTree(self)
        self.tree.add_command(_Commands(manager), guild=discord.Object(id=guild_id))

    async def setup_hook(self) -> None:
        # setup_hook runs once per login, unlike on_ready which also runs on reconnects.
        await self.tree.sync(guild=discord.Object(id=self.guild_id))

    async def on_ready(self) -> None:
        await self.manager._dispatch_event(self, self._reconcile_ready)

    async def _reconcile_ready(self) -> None:
        if self.manager._client is self:
            self.manager._error = None
            reconcile = getattr(self.manager.service, "reconcile_memberships", None)
            if self.manager._settings.get("discord_role_events") and reconcile and not self._reconciling:
                self._reconciling = True
                try:
                    await reconcile()
                except Exception:
                    self.manager._error = "Membership reconciliation could not complete. Check the Jellyport web page."
                finally:
                    self._reconciling = False

    async def on_error(self, event_method: str, *args: Any, **kwargs: Any) -> None:
        # Never log the exception or its arguments: HTTP payloads can contain credentials.
        if self.manager._client is self:
            self.manager._error = "A Discord event could not be processed."

    async def on_message(self, message: discord.Message) -> None:
        await self.manager._dispatch_event(self, self.manager.handle_subscription_message, message)

    async def on_member_update(self, before: discord.Member, after: discord.Member) -> None:
        await self.manager._dispatch_event(self, self.manager.handle_member_update, before, after)

    async def on_member_remove(self, member: discord.Member) -> None:
        await self.manager._dispatch_event(self, self.manager.handle_member_remove, member)


class BotManager:
    def __init__(self, service: MigrationService):
        self.service = service
        self._settings: dict[str, Any] = {}
        self._client: _Client | None = None
        self._task: asyncio.Task | None = None
        self._event_tasks: set[asyncio.Task] = set()
        self._error: str | None = None
        self._lock = asyncio.Lock()

    def status(self) -> dict[str, Any]:
        client = self._client
        return {
            "enabled": bool(self._settings.get("discord_enabled")),
            "connected": bool(client and client.is_ready() and not client.is_closed()),
            "error": self._error,
        }

    async def restart(self, settings: dict[str, Any]) -> None:
        async with self._lock:
            await self._stop_unlocked()
            self._settings = dict(settings)
            self._error = None
            token = self._settings.get("discord_bot_token")
            if not self._settings.get("discord_enabled"):
                return
            guild_id = _snowflake(self._settings.get("discord_guild_id"))
            if not isinstance(token, str) or not token.strip() or guild_id is None:
                self._error = "Configure a Discord bot token and valid server ID."
                return
            for field in ("discord_admin_role_id", "discord_member_role_id"):
                if self._settings.get(field) not in (None, "") and _snowflake(self._settings[field]) is None:
                    self._error = "Configure valid Discord role IDs."
                    return
            if self._settings.get("discord_message_events") and any(
                _snowflake(self._settings.get(field)) is None
                for field in ("discord_subscription_channel_id", "discord_subscription_bot_id")
            ):
                self._error = "Configure the trusted subscription channel and MEE6 bot IDs."
                return
            if self._settings.get("discord_role_events") and not _snowflake(self._settings.get("discord_member_role_id")):
                self._error = "Configure a membership role before enabling role events."
                return
            self._client = _Client(self, guild_id)
            self._task = asyncio.create_task(self._run(self._client, token), name="jellyport-discord")

    async def _run(self, client: _Client, token: str) -> None:
        try:
            await client.start(token, reconnect=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            if self._client is client:
                self._error = "Discord connection failed. Check the bot token, server ID, and installation."
        finally:
            with contextlib.suppress(Exception):
                await client.close()

    async def _stop_unlocked(self) -> None:
        client, task = self._client, self._task
        self._client = None
        self._task = None
        # discord.py dispatches events in separate tasks from Client.start().
        # Detaching the client prevents new tasks from touching the old service,
        # then drain existing callbacks before the caller can close its store.
        caller = asyncio.current_task()
        callbacks = [callback for callback in self._event_tasks if callback is not caller]
        for callback in callbacks:
            callback.cancel()
        if callbacks:
            await asyncio.gather(*callbacks, return_exceptions=True)
        if client:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(client.close(), timeout=10)
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _dispatch_event(self, client: _Client, callback: Callable[..., Awaitable[Any]], *args: Any) -> None:
        if self._client is not client:
            return
        task = asyncio.current_task()
        if task is not None:
            self._event_tasks.add(task)
        try:
            await callback(*args)
        finally:
            if task is not None:
                self._event_tasks.discard(task)

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_unlocked()

    def _guild(self) -> discord.Guild:
        client = self._client
        if not client or not client.is_ready() or client.is_closed():
            raise BotError("The Discord bot is offline. Connect it before sending credentials.")
        guild_id = _snowflake(self._settings.get("discord_guild_id"))
        guild = client.get_guild(guild_id) if guild_id else None
        if guild is None or guild.unavailable:
            raise BotError("The configured Discord server is unavailable to the bot.")
        return guild

    async def _fetch_member(self, user_id: Any) -> discord.Member:
        guild = self._guild()
        user_id = _snowflake(user_id)
        if user_id is None:
            raise BotError("Select a valid Discord server member.")
        try:
            # Fetch through REST every time. Role removals must not depend on member cache.
            return await asyncio.wait_for(guild.fetch_member(user_id), timeout=20)
        except discord.NotFound:
            raise BotError("The recipient is no longer a member of the configured Discord server.") from None
        except Exception:
            raise BotError("Discord membership could not be verified. Check bot access and the configured server.") from None

    async def recipient_identity(self, user_id: str | int, require_membership: bool = True) -> dict[str, str]:
        member = await self._fetch_member(user_id)
        if not recipient_eligible(
            member.guild.id,
            self._settings.get("discord_guild_id"),
            bot=member.bot,
            role_ids=(role.id for role in member.roles),
            member_role_id=self._settings.get("discord_member_role_id") if require_membership else None,
        ):
            raise BotError("The recipient must be a human server member with the configured membership role.")
        return {"id": str(member.id), "username": member.name}

    async def validate_recipient(self, user_id: str | int, require_membership: bool = True) -> None:
        await self.recipient_identity(user_id, require_membership=require_membership)

    async def membership_active(self, user_id: str | int) -> bool | None:
        """Three-state check: an API outage must never become a loss of membership."""
        try:
            guild = self._guild()
            user_id = _snowflake(user_id)
            if user_id is None:
                return None
            member = await asyncio.wait_for(guild.fetch_member(user_id), timeout=20)
            return recipient_eligible(
                member.guild.id,
                self._settings.get("discord_guild_id"),
                bot=member.bot,
                role_ids=(role.id for role in member.roles),
                member_role_id=self._settings.get("discord_member_role_id"),
            )
        except discord.NotFound:
            return False
        except Exception:
            return None

    async def active_members(self) -> list[dict[str, str]] | None:
        """Fresh active-role membership for opt-in provisioning reconciliation."""
        role_id = _snowflake(self._settings.get("discord_member_role_id"))
        if not self._settings.get("discord_role_events") or role_id is None:
            return None

        async def collect() -> list[dict[str, str]]:
            result = []
            async for member in self._guild().fetch_members(limit=None):
                if recipient_eligible(
                    member.guild.id,
                    self._settings.get("discord_guild_id"),
                    bot=member.bot,
                    role_ids=(role.id for role in member.roles),
                    member_role_id=role_id,
                ):
                    result.append({"id": str(member.id), "username": member.name})
            return result

        try:
            return await asyncio.wait_for(collect(), timeout=30)
        except Exception:
            # A partial listing or network error must not look like an empty role.
            return None

    async def deliver(self, user_id: str | int, username: str, password: str, server_url: str) -> None:
        """Called only by the service's explicitly authorized credential delivery workflow."""
        member = await self._fetch_member(user_id)
        if not recipient_eligible(
            member.guild.id,
            self._settings.get("discord_guild_id"),
            bot=member.bot,
            role_ids=(role.id for role in member.roles),
            member_role_id=self._settings.get("discord_member_role_id"),
        ):
            raise BotError("The recipient must be a human server member with the configured membership role.")
        content = credential_message(username, password, server_url or self._settings.get("jellyfin_public_url", ""))
        try:
            await asyncio.wait_for(
                member.send(content, allowed_mentions=discord.AllowedMentions.none(), suppress_embeds=True),
                timeout=20,
            )
        except Exception:
            raise BotError("Discord could not deliver the message. Ask the user to allow direct messages, then retry delivery.") from None

    async def _prepare(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        if _snowflake(interaction.guild_id) != _snowflake(self._settings.get("discord_guild_id")) or interaction.guild_id is None:
            raise BotError("This command is restricted to the configured Discord server.")
        member = await self._fetch_member(interaction.user.id)
        if member.bot or not command_authorized(
            member.guild.id,
            self._settings.get("discord_guild_id"),
            administrator=member.guild_permissions.administrator,
            role_ids=(role.id for role in member.roles),
            admin_role_id=self._settings.get("discord_admin_role_id"),
        ):
            raise BotError("This command requires server Administrator permission or the configured admin role.")

    async def _reply(self, interaction: discord.Interaction, message: str) -> None:
        try:
            if interaction.response.is_done():
                await interaction.followup.send(
                    message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none(), suppress_embeds=True
                )
            else:
                await interaction.response.send_message(
                    message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none(), suppress_embeds=True
                )
        except Exception:
            # Interaction expiry and network errors are never logged with request data.
            self._error = "A Discord command response could not be delivered."

    async def handle_create(self, interaction: discord.Interaction, user: discord.Member, username: str | None = None) -> None:
        try:
            await self._prepare(interaction)
            identity = await self.recipient_identity(user.id)
            if username is not None and username != identity["username"]:
                raise BotError("New account usernames must match the recipient's current Discord username.")
            job = await self.service.create_account(identity["username"], discord_user_id=identity["id"])
            message = job_status_message(job) + " Use /jellyport status to check progress."
        except BotError as error:
            message = str(error)
        except Exception:
            message = "Account creation could not be queued. Check the Jellyport web page."
        await self._reply(interaction, message)

    async def handle_migrate(self, interaction: discord.Interaction, user: discord.Member, emby_username: str | None = None) -> None:
        try:
            await self._prepare(interaction)
            identity = await self.recipient_identity(user.id)
            emby_username = emby_username if emby_username is not None else identity["username"]
            users = await self.service.emby_users()
            matches = [item for item in users if item.get("Name") == emby_username]
            if len(matches) != 1 or not matches[0].get("Id"):
                raise BotError("No unique Emby user matches that exact username. Check the Emby user list in the web page.")
            source_id = str(matches[0]["Id"])
            job = await self.service.migrate_users([source_id], discord_recipients={source_id: str(user.id)})
            message = job_status_message(job) + " Use /jellyport status to check progress."
        except BotError as error:
            message = str(error)
        except Exception:
            message = "Migration could not be queued. Check the Jellyport web page."
        await self._reply(interaction, message)

    async def _resolve_username(self, username: str) -> dict[str, str] | None:
        async def find() -> dict[str, str] | None:
            matches = []
            async for member in self._guild().fetch_members(limit=None):
                # Nicknames and display names can be duplicated or impersonated.
                if not member.bot and member.name == username:
                    matches.append({"id": str(member.id), "username": member.name})
                    if len(matches) > 1:
                        return None
            return matches[0] if len(matches) == 1 else None

        return await asyncio.wait_for(find(), timeout=30)

    async def handle_subscription_message(self, message: discord.Message) -> None:
        settings = self._settings
        if (
            not settings.get("discord_message_events")
            or message.guild is None
            or _snowflake(message.guild.id) != _snowflake(settings.get("discord_guild_id"))
            or _snowflake(message.channel.id) != _snowflake(settings.get("discord_subscription_channel_id"))
            or not message.author.bot
            or _snowflake(message.author.id) != _snowflake(settings.get("discord_subscription_bot_id"))
            or message.webhook_id is not None
        ):
            return
        parsed = parse_subscription_message(message.content)
        if parsed is None:
            return
        identity = None
        try:
            if parsed["discord_user_id"]:
                identity = await self.recipient_identity(parsed["discord_user_id"], require_membership=False)
            elif parsed["username"]:
                identity = await self._resolve_username(parsed["username"])
        except Exception:
            # An unresolved identity is recorded for review; it cannot provision accounts.
            pass
        event = {
            **parsed,
            "id": str(message.id),
            "guild_id": str(message.guild.id),
            "discord_user_id": identity["id"] if identity else None,
            "username": identity["username"] if identity else parsed["username"],
            "source": "mee6_message",
            "emitted_at": message.created_at.isoformat(),
        }
        try:
            await self.service.record_subscription(event)
        except Exception:
            self._error = "A subscription event could not be recorded. Check the Jellyport web page."

    async def handle_member_update(self, before: discord.Member, after: discord.Member) -> None:
        settings = self._settings
        role_id = _snowflake(settings.get("discord_member_role_id"))
        if (
            not settings.get("discord_role_events")
            or role_id is None
            or after.bot
            or before.id != after.id
            or before.guild.id != after.guild.id
            or _snowflake(after.guild.id) != _snowflake(settings.get("discord_guild_id"))
        ):
            return
        had_role = role_id in {role.id for role in before.roles}
        has_role = role_id in {role.id for role in after.roles}
        if had_role == has_role:
            return
        action = "subscribe" if has_role else "expire"
        emitted_at = datetime.now(timezone.utc).isoformat()
        event = {
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"discord-role:{after.guild.id}:{after.id}:{role_id}:{action}:{emitted_at}")),
            "guild_id": str(after.guild.id),
            "discord_user_id": str(after.id),
            "username": after.name,
            "action": action,
            "source": "discord_role",
            "detail": "Membership role added." if has_role else "Membership role removed.",
            "emitted_at": emitted_at,
        }
        try:
            await self.service.record_subscription(event)
        except Exception:
            self._error = "A membership role event could not be recorded. Check the Jellyport web page."

    async def handle_member_remove(self, member: discord.Member) -> None:
        if (
            not self._settings.get("discord_role_events")
            or member.bot
            or _snowflake(member.guild.id) != _snowflake(self._settings.get("discord_guild_id"))
        ):
            return
        emitted_at = datetime.now(timezone.utc).isoformat()
        event = {
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"discord-leave:{member.guild.id}:{member.id}:{emitted_at}")),
            "guild_id": str(member.guild.id),
            "discord_user_id": str(member.id),
            "username": member.name,
            "action": "expire",
            "source": "discord_role",
            "detail": "Member left the Discord server.",
            "emitted_at": emitted_at,
        }
        try:
            await self.service.record_subscription(event)
        except Exception:
            self._error = "A membership departure could not be recorded. Check the Jellyport web page."

    async def handle_status(self, interaction: discord.Interaction, job_id: str) -> None:
        try:
            await self._prepare(interaction)
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", job_id):
                raise BotError("Enter a valid Jellyport job ID.")
            job = self.service.get_job(job_id)
            if not job:
                raise BotError("That Jellyport job could not be found.")
            message = job_status_message(job)
        except BotError as error:
            message = str(error)
        except Exception:
            message = "Job status could not be read. Check the Jellyport web page."
        await self._reply(interaction, message)
