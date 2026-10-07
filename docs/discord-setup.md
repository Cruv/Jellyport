# Discord setup

Discord support is optional. Start with administrator commands and the review queue, then enable automatic actions after checking account links and your membership role behavior.

## Create and invite the bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its application ID and generate its bot token on the Bot page. Keep the token private.
2. Use a server/guild installation with the `bot` and `applications.commands` scopes. Jellyport uses an outbound Gateway connection; leave the Interactions Endpoint URL unset. No inbound public Discord endpoint is required.
3. In Jellyport Settings, save the application ID, bot token, and your Discord server ID. Enable Developer Mode in Discord to copy numeric server, user, role, and channel IDs.
4. Use Jellyport's generated invite link to install the bot in that server, then enable Discord and check its connection status. Saving settings restarts the bot. Slash commands are synchronized only to the configured server.

The generated invite requests View Channels, Send Messages, and Read Message History. The bot does not need Administrator or Manage Roles permissions. Restrict its channel access to where you run commands and, if enabled, the subscription announcement channel. Discord's [installation guide](https://docs.discord.com/developers/quick-start/getting-started) explains tokens, scopes, and guild installation.

## Command access and recipients

Every command checks the configured server and requires either the invoking member's Administrator guild permission or the configured admin role. Commands in DMs and other servers are rejected. Default Discord command visibility is Administrator-only. If you configure a separate admin role, also grant it command access through Discord's server Integrations settings; this UI grant does not bypass Jellyport's runtime authorization.

Configure an optional membership role ID to require recipients to hold your MEE6-managed active subscriber role. Membership is fetched afresh before provisioning and before sending credentials. Bot accounts cannot receive credentials. Recipients must currently belong to the configured server.

```text
/jellyport create user:@jlogan35
/jellyport migrate user:@jlogan35 emby_username:jlogan35
/jellyport status job_id:YOUR_JOB_ID
```

Create uses the recipient's current Discord username, `member.name`. Its optional `username` argument is only a confirmation and must match exactly. Migration's optional `emby_username` selects an exact Emby username; when omitted, it defaults to the member's current Discord username. The first identity link still requires the Emby and Discord usernames to match. Nicknames and display names are not identities.

Replies are ephemeral job statuses visible to the administrator. There is no automatic status polling; check the job with `/jellyport status` or the web page. New credentials are sent by DM only to the selected member. Users need to allow DMs from server members. Failed delivery leaves the new password available through the web app's one-time reveal for up to 24 hours. Existing Jellyfin passwords are not reset or sent by an ordinary migration.

## Choose event sources and intents

Privileged intents must be enabled both in the Developer Portal's Bot settings and through the corresponding Jellyport options. Slash commands alone do not request these intents. Presence Intent is not needed. See Discord's [Gateway intent documentation](https://docs.discord.com/developers/events/gateway#privileged-intents).

| Jellyport option | Developer Portal toggles | Purpose |
| --- | --- | --- |
| Commands only | No privileged intents | Admin account actions and credential delivery |
| MEE6 message events | Message Content Intent and Server Members Intent | Read trusted announcements; resolve plain usernames against fresh member data |
| Membership role events | Server Members Intent | Observe active role additions/removals and member departures |

To read MEE6 announcements, set both `discord_subscription_channel_id` and `discord_subscription_bot_id`. Use the numeric ID of your subscription channel, such as `buried-treasure`, and the actual MEE6 bot user ID. Messages are accepted only from that bot account in that channel and server. Webhooks and other authors are ignored.

Only these anchored plain-text templates are recognized, allowing capitalization and spacing variations:

```text
Good news captain! @jlogan35 just subscribed to Sloop Crewman Plan!
Bad news captain! jlogan35  just cancelled their subscription.
```

An actual Discord mention such as `<@USER_ID>` is resolved by ID. A plain username must uniquely match a current member's exact Discord username; aliases are ignored. Unresolved identities are recorded for review and cannot trigger automatic account changes. Announcement text in embed titles or descriptions is not currently parsed. Other message formats need a parser update rather than being interpreted loosely.

To observe membership role events, set `discord_member_role_id` to the role representing **currently entitled access**, then enable role events. Adding it produces a subscribe event; removing it or leaving the server produces an expire event. Configure MEE6's role behavior so this role remains active for the entire paid access period if you want expiration to follow that period.

## Review before enabling automatic actions

All automatic actions start disabled. Recognized events enter the web app's subscription queue, where you can apply or ignore them. An unresolved event requires a verified manual account action rather than an automatic username guess.

Enabling automatic provisioning applies resolved subscribe events. For an unlinked member, Jellyport migrates an exact matching Emby user when present, or creates a fresh template-based Jellyfin account otherwise. If a Jellyfin account already exists without a Discord link, an admin-approved migration must establish ownership first. Once linked, returning members can regain access to the same account if Jellyport disabled it.

Enabling automatic disabling applies expire events to linked accounts. Cancellation announcements remain for review by default: cancelling renewal does not establish when paid access ends. The separate “disable on cancellation” option also applies cancellations immediately when automatic disabling is enabled. Manually applying a cancellation event disables its linked account immediately, regardless of that automatic-action option.

Disabling changes account access while preserving passwords and watched history. Jellyfin administrators and the template user are protected. Accounts disabled independently by an administrator are not automatically re-enabled. Missing or changed links and unavailable membership checks are recorded for review instead of assuming an account may be changed.

Jellyport does not query MEE6 billing, determine paid-through dates, or recover old announcement messages. With role events enabled, it reconciles linked memberships on startup/reconnect and every five minutes, using current membership rather than replaying old changes. It can detect missing roles and departed linked users after downtime. With automatic provisioning also enabled, it scans current active-role members for unlinked subscribers, including members who joined during downtime. Enabling this combination can provision **all current active-role members without an identity link**, so check that role's membership first. With only message events enabled, announcements missed while the app was offline require a new recognized event or an administrator action.

Discord IDs are the durable link; usernames can change. Lifecycle actions keep using the saved Jellyfin account and do not rename it. Resolve legacy Emby/Discord username mismatches before the first link, and inspect stale queued events before applying them.
