import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import discord
import pytest

from app.bot import (
    BotError,
    BotManager,
    _Client,
    command_authorized,
    credential_message,
    job_status_message,
    parse_subscription_message,
    recipient_eligible,
)


def member(user_id=22, username="jlogan35", *, roles=(55,), administrator=False, bot=False, guild_id=123):
    return SimpleNamespace(
        id=user_id,
        name=username,
        nick="Display alias",
        display_name="Display alias",
        bot=bot,
        guild=SimpleNamespace(id=guild_id),
        roles=[SimpleNamespace(id=role) for role in roles],
        guild_permissions=SimpleNamespace(administrator=administrator),
        send=AsyncMock(),
    )


def interaction(guild_id=123, user_id=11):
    return SimpleNamespace(
        guild_id=guild_id,
        user=SimpleNamespace(id=user_id),
        response=SimpleNamespace(defer=AsyncMock(), is_done=Mock(return_value=True), send_message=AsyncMock()),
        followup=SimpleNamespace(send=AsyncMock()),
    )


@pytest.fixture
def manager():
    service = SimpleNamespace(
        create_account=AsyncMock(return_value={"id": "job_1", "status": "queued", "password": "NEVER-IN-CHANNEL"}),
        migrate_users=AsyncMock(return_value={"id": "job_2", "status": "queued"}),
        emby_users=AsyncMock(return_value=[{"Id": "emby_1", "Name": "jlogan35"}]),
        get_job=Mock(return_value={"id": "job_1", "status": "running", "processed": 1, "total": 2, "password": "SECRET"}),
        record_subscription=AsyncMock(),
        reconcile_memberships=AsyncMock(),
    )
    manager = BotManager(service)
    manager._settings = {
        "discord_guild_id": "123",
        "discord_admin_role_id": "99",
        "discord_member_role_id": "55",
        "jellyfin_public_url": "https://jellyfin.example.test",
    }
    admin = member(11, "server_admin", roles=(99,))
    recipient = member()
    guild = SimpleNamespace(
        id=123,
        unavailable=False,
        fetch_member=AsyncMock(side_effect=lambda user_id: admin if user_id == 11 else recipient),
    )
    manager._client = SimpleNamespace(
        is_ready=Mock(return_value=True),
        is_closed=Mock(return_value=False),
        get_guild=Mock(return_value=guild),
    )
    return manager


@pytest.mark.parametrize(
    "guild,configured,admin,roles,role,expected",
    [
        (123, "123", True, [], None, True),
        (123, "123", False, [99], "99", True),
        (123, "123", False, [55], "99", False),
        (None, "123", True, [99], "99", False),
        (456, "123", True, [99], "99", False),
        (123, None, True, [], None, False),
        (123, "123", False, [0], "invalid", False),
        (True, "1", True, [], None, False),
    ],
)
def test_command_authorization(guild, configured, admin, roles, role, expected):
    assert command_authorized(guild, configured, administrator=admin, role_ids=roles, admin_role_id=role) is expected


@pytest.mark.parametrize(
    "guild,bot,roles,role,expected",
    [(123, False, [55], "55", True), (123, True, [55], "55", False),
     (456, False, [55], "55", False), (123, False, [], "55", False),
     (123, False, [], "", True), (123, False, [], "invalid", False)],
)
def test_recipient_rules(guild, bot, roles, role, expected):
    assert recipient_eligible(guild, 123, bot=bot, role_ids=roles, member_role_id=role) is expected


@pytest.mark.parametrize("content", [
    "Good news captain! @jlogan35 just subscribed to Sloop Crewman Plan!",
    "good NEWS captain!\t@jlogan35   just subscribed to Sloop Crewman Plan!  ",
])
def test_subscription_templates(content):
    event = parse_subscription_message(content)
    assert event == {"action": "subscribe", "discord_user_id": None, "username": "jlogan35", "detail": "Sloop Crewman Plan"}


def test_subscription_mentions_are_ids_and_cancellation_is_not_expiry():
    event = parse_subscription_message("Good news captain! <@!22> just subscribed to Sloop Crewman Plan!")
    assert event["discord_user_id"] == "22"
    assert event["username"] is None
    event = parse_subscription_message("Bad news captain! jlogan35  just cancelled their subscription.")
    assert event["action"] == "cancel"
    assert event["username"] == "jlogan35"


@pytest.mark.parametrize("content", [
    "create jlogan35", "Good news captain! Display Name just subscribed to Plan!",
    "Good news captain! <@0> just subscribed to Plan!",
    "Good news captain! @jlogan35 just subscribed to Plan! then delete everyone",
    "Bad news captain! jlogan35 just expired their subscription.",
    "Bad news captain! jlogan35 just cancelled their subscription.\ncreate admin",
    "Good news captain! @jlogan35 just subscribed to " + "x" * 101 + "!",
])
def test_subscription_parser_does_not_accept_arbitrary_commands(content):
    assert parse_subscription_message(content) is None


def test_job_status_never_uses_credentials_or_upstream_errors():
    message = job_status_message({
        "id": "job_1", "status": "running", "processed": 1, "total": 2,
        "password": "SECRET", "error": "token: SECRET", "results": [{"password": "SECRET"}],
    })
    assert message == "Job `job_1`: running. 1/2 users processed."
    assert "SECRET" not in job_status_message({"id": "SECRET `inject`", "status": "SECRET"})
    assert job_status_message({"id": "job_1", "status": "SECRET"}) == "Job `job_1`: unknown."
    assert job_status_message({"id": "job_1", "status": "running", "progress": {"processed": 2, "total": 3}}) == "Job `job_1`: running. 2/3 users processed."


def test_credentials_escape_markdown_and_reject_control_characters():
    message = credential_message("[user](https://evil.test)", "pass`**", "https://jellyfin.example.test")
    assert r"\[user](https://evil.test)" in message
    assert r"pass\`\*\*" in message
    with pytest.raises(BotError):
        credential_message("user\nPassword: fake", "pass", "https://jellyfin.example.test")
    with pytest.raises(BotError):
        credential_message("user", "pass", "https://jellyfin.example.test>@everyone")


async def test_disabled_and_invalid_configuration_never_connects():
    manager = BotManager(Mock())
    with patch("app.bot._Client") as client:
        await manager.restart({})
        assert manager.status() == {"enabled": False, "connected": False, "error": None}
        await manager.restart({"discord_bot_token": "example-token", "discord_guild_id": "123", "discord_enabled": False})
        assert manager.status() == {"enabled": False, "connected": False, "error": None}
        await manager.restart({"discord_bot_token": "example-token", "discord_guild_id": "invalid", "discord_enabled": True})
        assert manager.status()["error"]
        await manager.restart({"discord_bot_token": "example-token", "discord_guild_id": "123", "discord_message_events": True, "discord_enabled": True})
        assert "trusted" in manager.status()["error"]
        client.assert_not_called()


async def test_gateway_intents_and_command_registration_are_opt_in():
    manager = BotManager(Mock())
    client = _Client(manager, 123)
    assert client.intents.guilds
    assert not client.intents.members
    assert not client.intents.message_content
    assert not client.intents.guild_messages
    assert not client.tree.get_commands()
    group = client.tree.get_commands(guild=discord.Object(id=123))[0]
    assert group.guild_only
    assert group.default_permissions.administrator
    assert {command.name for command in group.commands} == {"create", "migrate", "status"}
    client.tree.sync = AsyncMock()
    await client.setup_hook()
    assert client.tree.sync.await_args.kwargs["guild"].id == 123
    await client.close()
    manager._settings = {"discord_message_events": True}
    client = _Client(manager, 123)
    assert client.intents.message_content and client.intents.members and client.intents.guild_messages
    assert not client.intents.dm_messages
    await client.close()
    manager._settings = {"discord_role_events": True}
    client = _Client(manager, 123)
    assert client.intents.members and not client.intents.message_content
    await client.close()


@pytest.mark.parametrize("guild_id", [None, 456])
@pytest.mark.parametrize("command", ["create", "migrate", "status"])
async def test_every_command_rejects_dms_and_other_guilds(manager, guild_id, command):
    request = interaction(guild_id)
    if command == "create":
        await manager.handle_create(request, member())
    elif command == "migrate":
        await manager.handle_migrate(request, member())
    else:
        await manager.handle_status(request, "job_1")
    manager.service.create_account.assert_not_awaited()
    manager.service.migrate_users.assert_not_awaited()
    manager.service.get_job.assert_not_called()
    manager._client.get_guild.assert_not_called()
    request.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    assert request.followup.send.await_args.kwargs["ephemeral"]


@pytest.mark.parametrize("command", ["create", "migrate", "status"])
async def test_every_command_checks_runtime_roles(manager, command):
    manager._client.get_guild.return_value.fetch_member.return_value = member(11, roles=())
    manager._client.get_guild.return_value.fetch_member.side_effect = None
    request = interaction()
    if command == "create":
        await manager.handle_create(request, member())
    elif command == "migrate":
        await manager.handle_migrate(request, member())
    else:
        await manager.handle_status(request, "job_1")
    assert "requires" in request.followup.send.await_args.args[0]
    manager.service.create_account.assert_not_awaited()
    manager.service.migrate_users.assert_not_awaited()
    manager.service.get_job.assert_not_called()


async def test_create_uses_current_username_not_display_alias_and_redacts_job(manager):
    request = interaction()
    guild = manager._client.get_guild.return_value
    original = guild.fetch_member.side_effect

    async def fetch(user_id):
        request.response.defer.assert_awaited()
        return original(user_id)

    guild.fetch_member.side_effect = fetch
    await manager.handle_create(request, member(username="cached-old-name"))
    manager.service.create_account.assert_awaited_once_with("jlogan35", discord_user_id="22")
    reply = request.followup.send.await_args
    assert "NEVER-IN-CHANNEL" not in reply.args[0]
    assert reply.kwargs["ephemeral"]
    assert reply.kwargs["allowed_mentions"].to_dict() == {"parse": []}
    request = interaction()
    await manager.handle_create(request, member(), "Display alias")
    assert manager.service.create_account.await_count == 1
    assert "must match" in request.followup.send.await_args.args[0]


async def test_migrate_selects_exact_source_and_current_recipient(manager):
    request = interaction()
    await manager.handle_migrate(request, member())
    manager.service.migrate_users.assert_awaited_once_with(["emby_1"], discord_recipients={"emby_1": "22"})
    await manager.handle_migrate(interaction(), member(), "JLOGAN35")
    assert manager.service.migrate_users.await_count == 1


async def test_recipient_role_is_fetched_again_at_delivery(manager):
    recipient = member()
    removed_role = member(roles=())
    manager._client.get_guild.return_value.fetch_member.side_effect = [recipient, removed_role]
    await manager.validate_recipient("22")
    with pytest.raises(BotError, match="membership role"):
        await manager.deliver("22", "jlogan35", "SECRET", "https://jellyfin.example.test")
    recipient.send.assert_not_awaited()
    removed_role.send.assert_not_awaited()


async def test_delivery_only_messages_chosen_member_and_disables_mentions(manager):
    recipient = await manager._fetch_member(22)
    await manager.deliver("22", "jlogan35", "private-password", "https://jellyfin.example.test")
    call = recipient.send.await_args
    assert "Username: jlogan35" in call.args[0]
    assert "Password: private-password" in call.args[0]
    assert call.kwargs["allowed_mentions"].to_dict() == {"parse": []}
    assert call.kwargs["suppress_embeds"]


async def test_delivery_errors_are_fixed_and_offline_delivery_fails(manager):
    recipient = await manager._fetch_member(22)
    recipient.send.side_effect = RuntimeError("private-password secret-token")
    with pytest.raises(BotError) as error:
        await manager.deliver("22", "jlogan35", "private-password", "https://jellyfin.example.test")
    assert "private-password" not in str(error.value)
    assert "secret-token" not in str(error.value)
    manager._client.is_ready.return_value = False
    with pytest.raises(BotError, match="offline"):
        await manager.deliver("22", "jlogan35", "private-password", "https://jellyfin.example.test")


async def test_command_upstream_exceptions_are_redacted(manager):
    manager.service.create_account.side_effect = RuntimeError("password SECRET token SECRET")
    request = interaction()
    await manager.handle_create(request, member())
    assert "SECRET" not in request.followup.send.await_args.args[0]
    request = interaction()
    await manager.handle_status(request, "job_1")
    assert request.followup.send.await_args.args[0] == "Job `job_1`: running. 1/2 users processed."


async def test_membership_active_distinguishes_absence_and_transient_failure(manager):
    guild = manager._client.get_guild.return_value
    assert await manager.membership_active(22) is True
    guild.fetch_member.side_effect = None
    guild.fetch_member.return_value = member(roles=())
    assert await manager.membership_active(22) is False
    guild.fetch_member.side_effect = discord.NotFound(SimpleNamespace(status=404, reason="Not Found"), "Missing")
    assert await manager.membership_active(22) is False
    guild.fetch_member.side_effect = RuntimeError("private-token")
    assert await manager.membership_active(22) is None
    manager._client.is_ready.return_value = False
    assert await manager.membership_active(22) is None


async def test_active_member_scan_is_opt_in_and_filters_by_role_and_identity(manager):
    guild = manager._client.get_guild.return_value
    guild.fetch_members = Mock()
    assert await manager.active_members() is None
    guild.fetch_members.assert_not_called()
    manager._settings["discord_role_events"] = True

    async def fetch_members(*, limit):
        assert limit is None
        for item in [member(), member(23, roles=()), member(24, bot=True), member(25, guild_id=456)]:
            yield item

    guild.fetch_members = fetch_members
    assert await manager.active_members() == [{"id": "22", "username": "jlogan35"}]


async def test_active_member_scan_never_returns_partial_results_on_failure(manager):
    manager._settings["discord_role_events"] = True

    async def fetch_members(*, limit):
        yield member()
        raise RuntimeError("secret-token")

    manager._client.get_guild.return_value.fetch_members = fetch_members
    assert await manager.active_members() is None
    manager._client.is_ready.return_value = False
    assert await manager.active_members() is None


def subscription_message(**overrides):
    values = {
        "id": 1000,
        "guild": SimpleNamespace(id=123),
        "channel": SimpleNamespace(id=700),
        "author": SimpleNamespace(id=800, bot=True),
        "webhook_id": None,
        "content": "Good news captain! <@22> just subscribed to Sloop Crewman Plan!",
        "created_at": datetime(2026, 10, 7, tzinfo=timezone.utc),
    }
    return SimpleNamespace(**(values | overrides))


def enable_messages(manager):
    manager._settings.update({
        "discord_message_events": True,
        "discord_subscription_channel_id": "700",
        "discord_subscription_bot_id": "800",
    })


@pytest.mark.parametrize("overrides", [
    {"guild": None}, {"guild": SimpleNamespace(id=456)}, {"channel": SimpleNamespace(id=701)},
    {"author": SimpleNamespace(id=801, bot=True)}, {"author": SimpleNamespace(id=800, bot=False)},
    {"webhook_id": 900}, {"content": "create user"},
])
async def test_subscription_ingestion_rejects_untrusted_sources(manager, overrides):
    enable_messages(manager)
    await manager.handle_subscription_message(subscription_message(**overrides))
    manager.service.record_subscription.assert_not_awaited()
    manager.service.create_account.assert_not_awaited()


async def test_mee6_events_opt_in_and_resolve_authoritative_member_name(manager):
    await manager.handle_subscription_message(subscription_message())
    manager.service.record_subscription.assert_not_awaited()
    enable_messages(manager)
    await manager.handle_subscription_message(subscription_message())
    event = manager.service.record_subscription.await_args.args[0]
    assert event["id"] == "1000"
    assert event["discord_user_id"] == "22"
    assert event["username"] == "jlogan35"
    assert event["action"] == "subscribe"
    assert event["source"] == "mee6_message"
    manager.service.create_account.assert_not_awaited()
    manager.service.migrate_users.assert_not_awaited()


@pytest.mark.parametrize("members,expected_id", [
    ([member()], "22"),
    ([member(username="other-user")], None),
    ([member(), member(23)], None),
])
async def test_plain_username_requires_exact_unique_discord_username(manager, members, expected_id):
    enable_messages(manager)

    async def fetch_members(*, limit):
        assert limit is None
        for item in members:
            yield item

    manager._client.get_guild.return_value.fetch_members = fetch_members
    await manager.handle_subscription_message(subscription_message(
        content="Bad news captain! jlogan35  just cancelled their subscription."
    ))
    event = manager.service.record_subscription.await_args.args[0]
    assert event["discord_user_id"] == expected_id
    assert event["action"] == "cancel"
    assert event["username"] == "jlogan35"


async def test_unresolvable_mention_becomes_review_only_event(manager):
    enable_messages(manager)
    manager._client.get_guild.return_value.fetch_member.side_effect = RuntimeError("private-token")
    await manager.handle_subscription_message(subscription_message())
    event = manager.service.record_subscription.await_args.args[0]
    assert event["discord_user_id"] is None
    assert "private-token" not in str(event)


async def test_role_changes_and_departures_emit_only_when_enabled(manager):
    before, after = member(roles=()), member()
    await manager.handle_member_update(before, after)
    manager.service.record_subscription.assert_not_awaited()
    manager._settings["discord_role_events"] = True
    await manager.handle_member_update(before, after)
    event = manager.service.record_subscription.await_args.args[0]
    assert event["action"] == "subscribe"
    assert event["discord_user_id"] == "22"
    assert event["source"] == "discord_role"
    await manager.handle_member_update(after, before)
    assert manager.service.record_subscription.await_args.args[0]["action"] == "expire"
    await manager.handle_member_update(after, after)
    assert manager.service.record_subscription.await_count == 2
    await manager.handle_member_update(before, member(guild_id=456))
    assert manager.service.record_subscription.await_count == 2
    await manager.handle_member_remove(after)
    assert manager.service.record_subscription.await_args.args[0]["action"] == "expire"


async def test_ready_reconciles_roles_after_startup_and_reconnect(manager):
    manager._settings["discord_role_events"] = True
    client = _Client(manager, 123)
    manager._client = client
    await client.on_ready()
    await client.on_ready()
    assert manager.service.reconcile_memberships.await_count == 2
    await client.close()


async def test_gateway_errors_do_not_expose_library_details():
    manager = BotManager(Mock())
    client = Mock()
    client.start = AsyncMock(side_effect=RuntimeError("secret-token"))
    client.close = AsyncMock()
    client.is_ready.return_value = False
    client.is_closed.return_value = True
    manager._client = client
    await manager._run(client, "secret-token")
    assert "secret-token" not in manager.status()["error"]
    client.close.assert_awaited()


async def test_stop_cancels_and_drains_pending_subscription_callback():
    service = Mock()
    manager = BotManager(service)
    client = _Client(manager, 123)
    manager._client = client
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending_subscription(message):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    manager.handle_subscription_message = pending_subscription
    task = asyncio.create_task(client.on_message(SimpleNamespace()))
    await asyncio.wait_for(started.wait(), timeout=1)
    assert task in manager._event_tasks
    await manager.stop()
    assert task.done()
    assert cancelled.is_set()
    assert not manager._event_tasks
    assert manager._client is None
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_stale_client_callback_cannot_touch_service():
    manager = BotManager(Mock())
    client = _Client(manager, 123)
    manager.handle_subscription_message = AsyncMock()
    await client.on_message(SimpleNamespace())
    manager.handle_subscription_message.assert_not_awaited()
    assert not manager._event_tasks
    await client.close()


async def test_stop_drains_pending_slash_command_before_it_can_queue_job():
    manager = BotManager(Mock())
    client = _Client(manager, 123)
    manager._client = client
    started = asyncio.Event()

    async def pending_command(*args):
        started.set()
        await asyncio.Event().wait()
        manager.service.create_account("unreachable")

    manager.handle_create = pending_command
    request = interaction()
    request.client = client
    group = client.tree.get_commands(guild=discord.Object(id=123))[0]
    command = group.get_command("create")
    task = asyncio.create_task(command.callback(group, request, member()))
    await asyncio.wait_for(started.wait(), timeout=1)
    await manager.stop()
    assert task.done()
    assert not manager._event_tasks
    manager.service.create_account.assert_not_called()
    with pytest.raises(asyncio.CancelledError):
        await task
