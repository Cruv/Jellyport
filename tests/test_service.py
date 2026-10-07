import copy
import json

import pytest

from app.demo import DemoServers
from app.media import MediaError
from app.service import Service, ServiceError, generate_password, template_policy
from app.store import DEFAULT_SETTINGS, Store


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path)
    servers = DemoServers()
    store.save_settings(DEFAULT_SETTINGS | {"emby_url": "http://emby", "emby_api_key": "secret-emby", "jellyfin_url": "http://jellyfin", "jellyfin_api_key": "secret-jellyfin", "template_user_id": "template"})
    service = Service(store, client_factory=servers.factory)
    yield service, store, servers
    store.close()


async def finish(service, job):
    task = service.job_tasks.get(job["id"])
    if task:
        await task
    return service.get_job(job["id"])


async def test_migration_new_account_then_repeat_preserves_credentials_and_watch_state(setup):
    service, store, servers = setup
    plan = await service.preview(["e-alex"])
    assert plan["users"][0]["stats"] == {"source_played": 4, "matched": 3, "unmatched": 1, "ambiguous": 0, "already_played": 0}
    job = await finish(service, await service.migrate_users(["e-alex"]))
    assert job["status"] == "partial"
    assert job["results"][0]["applied"] == 3
    alex = next(u for u in servers.users["jellyfin"] if u["Name"] == "alex")
    assert alex["Policy"] == servers.users["jellyfin"][0]["Policy"]
    credentials = store.take_credentials(job["id"])
    assert len(credentials) == 1 and len(credentials[0]["password"]) == 24
    assert store.take_credentials(job["id"]) == []
    rerun = await finish(service, await service.migrate_users(["e-alex"]))
    assert rerun["results"][0]["created"] is False
    assert rerun["results"][0]["applied"] == 0
    assert store.take_credentials(rerun["id"]) == []
    assert len([u for u in servers.users["jellyfin"] if u["Name"] == "alex"]) == 1


async def test_existing_account_permissions_and_played_items_are_preserved(setup):
    service, store, servers = setup
    river = servers.users["jellyfin"][1]
    river["Policy"]["EnableAllFolders"] = False
    before = copy.deepcopy(river)
    servers.played["j-river"].add("3")  # Played only in Jellyfin.
    job = await finish(service, await service.migrate_users(["e-river"]))
    assert job["status"] == "completed"
    assert river == before
    assert servers.played["j-river"] == {"1", "2", "3"}
    assert store.take_credentials(job["id"]) == []


async def test_create_duplicate_does_not_reset_existing_user(setup):
    service, _, servers = setup
    before = copy.deepcopy(servers.users["jellyfin"][1])
    job = await finish(service, await service.create_account("river"))
    assert job["status"] == "failed"
    assert servers.users["jellyfin"][1] == before


async def test_incomplete_owned_provisioning_can_resume(setup):
    service, store, servers = setup
    factory = servers.factory
    failing = True

    def client_factory(*args, **kwargs):
        client = factory(*args, **kwargs)
        original = client.set_policy
        async def policy(*policy_args):
            if failing:
                raise MediaError("Jellyfin rejected the request (HTTP 503).")
            await original(*policy_args)
        client.set_policy = policy
        return client

    service.client_factory = client_factory
    first = await finish(service, await service.create_account("casey"))
    assert first["status"] == "failed"
    assert store.account("casey")["status"] == "provisioning"
    failing = False
    second = await finish(service, await service.create_account("casey"))
    assert second["status"] == "completed"
    assert len([u for u in servers.users["jellyfin"] if u["Name"] == "casey"]) == 1
    assert len(store.take_credentials(second["id"])) == 1


async def test_uncertain_creation_is_not_retried_or_reset(setup):
    service, store, servers = setup
    factory = servers.factory
    calls = []
    def client_factory(*args, **kwargs):
        client = factory(*args, **kwargs)
        async def create(name, password):
            calls.append(name)
            raise MediaError("Jellyfin request timed out.")
        client.create_user = create
        return client
    service.client_factory = client_factory
    first = await finish(service, await service.create_account("casey"))
    second = await finish(service, await service.create_account("casey"))
    assert first["status"] == second["status"] == "failed"
    assert calls == ["casey"]
    assert store.account("casey")["status"] == "uncertain"


class FakeBot:
    def __init__(self):
        self.delivered = []
    async def validate_recipient(self, user_id, require_membership=True):
        return None
    async def recipient_identity(self, user_id, require_membership=True):
        return {"id": user_id, "username": "alex"}
    async def deliver(self, *args):
        self.delivered.append(args)
    async def membership_active(self, user_id):
        return False


async def test_delivery_credentials_do_not_enter_audit_records(setup):
    service, store, _ = setup
    service.bot = FakeBot()
    job = await finish(service, await service.migrate_users(["e-alex"], {"e-alex": "123456789"}))
    password = service.bot.delivered[0][2]
    assert password not in json.dumps(job)
    assert store.take_credentials(job["id"]) == []
    assert store.link("123456789")["username"] == "alex"


async def test_failed_discord_delivery_retains_one_time_credentials(setup):
    service, store, _ = setup
    service.bot = FakeBot()
    async def fail(*args):
        raise RuntimeError("Do not expose library exceptions.")
    service.bot.deliver = fail
    job = await finish(service, await service.create_account("alex", "123456789"))
    assert job["status"] == "partial"
    assert job["results"][0]["discord_delivery"] == "failed"
    assert "library exceptions" not in json.dumps(job)
    assert len(store.take_credentials(job["id"])) == 1


async def test_expiration_and_resubscription_only_toggle_linked_nonadmin(setup):
    service, store, servers = setup
    service.bot = FakeBot()
    alex_job = await finish(service, await service.create_account("alex", "123456789"))
    assert alex_job["status"] == "completed"
    alex = next(u for u in servers.users["jellyfin"] if u["Name"] == "alex")
    before = copy.deepcopy(alex["Policy"])
    await service.record_subscription({"id": "expire-1", "action": "expire", "username": "alex", "discord_user_id": "123456789", "source": "discord_role"})
    await service.apply_subscription("expire-1")
    assert alex["Policy"]["IsDisabled"] is True
    assert store.link("123456789")["disabled_by_jellyport"] == 1
    await service.record_subscription({"id": "sub-1", "action": "subscribe", "username": "alex", "discord_user_id": "123456789", "source": "discord_role"})
    await service.apply_subscription("sub-1")
    assert alex["Policy"] == before
    assert store.link("123456789")["disabled_by_jellyport"] == 0


async def test_cancellation_requires_review_by_default_and_events_deduplicate(setup):
    service, store, _ = setup
    event = {"id": "cancel-1", "action": "cancel", "username": "alex", "discord_user_id": "123456789", "source": "mee6_message"}
    await service.record_subscription(event)
    await service.record_subscription(event)
    assert len(store.subscriptions()) == 1
    assert store.subscription("cancel-1")["status"] == "pending"


async def test_expiration_never_claims_unlinked_username(setup):
    service, _, servers = setup
    service.bot = FakeBot()
    before = copy.deepcopy(servers.users["jellyfin"])
    await service.record_subscription({"id": "expire-unlinked", "action": "expire", "username": "river", "discord_user_id": "123456789", "source": "discord_role"})
    with pytest.raises(ServiceError, match="no Jellyport identity link"):
        await service.apply_subscription("expire-unlinked")
    assert servers.users["jellyfin"] == before


def test_admin_template_rejected():
    with pytest.raises(ServiceError):
        template_policy({"Policy": {"IsAdministrator": True}})
    with pytest.raises(ServiceError):
        template_policy({"Policy": {"IsDisabled": True}})
    assert len(generate_password()) == 24


def test_store_encrypts_api_keys_and_credentials(tmp_path):
    store = Store(tmp_path)
    store.save_settings(DEFAULT_SETTINGS | {"emby_api_key": "an-example-secret"})
    store.save_credentials("job", "alex", "another-password", "https://example.com")
    store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    assert b"an-example-secret" not in (tmp_path / "jellyport.db").read_bytes()
    assert b"another-password" not in (tmp_path / "jellyport.db").read_bytes()
    assert store.settings()["emby_api_key"] == "an-example-secret"
    store.close()


async def test_opt_in_active_role_scan_provisions_offline_join_and_deduplicates(setup):
    service, store, servers = setup
    service.bot = FakeBot()
    active = True
    async def membership(user_id):
        return active
    async def members():
        return [{"id": "123456789", "username": "alex"}] if active else []
    service.bot.membership_active = membership
    service.bot.active_members = members
    store.save_settings(store.settings() | {"discord_role_events": True, "discord_member_role_id": "12345678", "auto_provision": True, "auto_disable": True})
    await service.reconcile_memberships()
    assert store.link("123456789")["username"] == "alex"
    assert len(store.subscriptions()) == 1
    await service.reconcile_memberships()
    assert len(store.subscriptions()) == 1
    active = False
    await service.reconcile_memberships()
    assert store.link("123456789")["disabled_by_jellyport"] == 1
    alex = next(u for u in servers.users["jellyfin"] if u["Name"] == "alex")
    assert alex["Policy"]["IsDisabled"] is True


async def test_admin_disabled_account_is_not_reenabled_on_renewal(setup):
    service, store, servers = setup
    service.bot = FakeBot()
    river = servers.users["jellyfin"][1]
    river["Policy"]["IsDisabled"] = True
    store.save_link("123456789", "river", "j-river", False)
    await service.record_subscription({"id": "renewal", "action": "subscribe", "discord_user_id": "123456789", "username": "river", "source": "mee6_message"})
    await service.apply_subscription("renewal")
    assert river["Policy"]["IsDisabled"] is True


async def test_template_watch_history_is_not_used_for_new_account_preview(setup):
    service, _, servers = setup
    servers.played["template"] = {"1", "2", "3"}
    preview = await service.preview(["e-alex"])
    assert preview["users"][0]["stats"]["already_played"] == 0


async def test_unavailable_emby_does_not_hide_jellyfin_template_users(setup):
    service, _, servers = setup
    original = servers.factory
    def factory(*args, **kwargs):
        client = original(*args, **kwargs)
        if kwargs.get("kind") == "emby":
            async def unavailable():
                raise MediaError("Unable to connect to Emby.")
            client.users = unavailable
        return client
    service.client_factory = factory
    users = await service.users()
    assert users["emby"] == []
    assert users["jellyfin"][0]["Id"] == "template"
    assert users["errors"] == {"emby": "Unable to connect to Emby."}
