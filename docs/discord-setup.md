# Discord setup

Discord support is optional. Start with administrator commands and the review queue, then enable automatic actions after checking account links and your membership role behavior.

## Create and invite the bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its application ID and generate its bot token on the Bot page. Keep the token private.
2. Use a server/guild installation with the `bot` and `applications.commands` scopes. Jellyport uses an outbound Gateway connection; leave the Interactions Endpoint URL unset. No inbound public Discord endpoint is required.
3. In Jellyport Settings, save the application ID, bot token, and your Discord server ID. Enable Developer Mode in Discord to copy numeric server, role, and channel IDs. Individual members can be selected through Jellyport's search without copying their user IDs.
4. Use Jellyport's generated invite link to install the bot in that server, then enable Discord and check its connection status. Saving settings restarts the bot. Slash commands are synchronized only to the configured server.

The generated invite requests View Channels, Send Messages, and Read Message History. Configuring organization roles also adds Manage Roles to the invite; update the bot installation or grant that permission before applying role tags. Administrator permission is not required. Restrict its channel access to where you run commands and, if enabled, the subscription announcement channel. Discord's [installation guide](https://docs.discord.com/developers/quick-start/getting-started) explains tokens, scopes, and guild installation.

## Command access and recipients

Every command checks the configured server and requires either the invoking member's Administrator guild permission or the configured admin role. Commands in DMs and other servers are rejected. Default Discord command visibility is Administrator-only. If you configure a separate admin role, also grant it command access through Discord's server Integrations settings; this UI grant does not bypass Jellyport's runtime authorization.

Configure an optional membership role ID to require subscription-managed recipients to hold your MEE6-managed active subscriber role. Membership is fetched afresh before provisioning and before sending credentials. Saved complimentary members do not need the subscriber role. Bot accounts cannot receive credentials. Recipients must currently belong to the configured server for bot commands and credential delivery, including complimentary recipients.

```text
/jellyport create user:@jlogan35
/jellyport create user:@jlogan35 tier:brigantine
/jellyport migrate user:@jlogan35 emby_username:jlogan35
/jellyport status job_id:YOUR_JOB_ID
```

Create provisions the recipient's full saved account allowance, including a saved complimentary allowance. Its optional `tier` argument selects a configured membership tier; omitting it preserves a saved tier or uses the initial default for a new member. New account names begin with the recipient's current Discord username, `member.user.username`, followed by `_2` and `_3` for additional slots. Existing links and approved slot mappings preserve their saved destination names. Its optional `username` argument is only a confirmation of the current Discord username and must match exactly.

Migration selects a saved Emby mapping by verified Discord ID. When the owner has several mappings, specify the exact `emby_username` to choose the account; an ambiguous command is rejected. An explicit source must belong to one of that owner's approved mappings. Without a mapping, the optional argument selects an exact source username, defaulting to the member's current Discord username, subject to the usual ownership checks.

For creation and migration, the first identity link requires matching usernames or an administrator-approved mapping with that verified Discord ID. To associate an existing Jellyfin account directly, an administrator can instead select that exact account under **Users → Link Discord owner** and confirm the Discord owner and account slot. This preserves its password, policy, preferences, and personal data. Set name exceptions under **User mappings** in the web app. A manually entered Discord name without an ID is an unverified label and never selects a command recipient or authorizes an account link. Nicknames and display names are not identities.

### Select members in the web app

The Discord member picker is available in **User mappings**, **Memberships**, **Users → Link Discord owner**, migration previews, fresh account creation, and incomplete-account recovery. Search by a prefix of the member's actual username or server nickname, then select the matching result. Search does not use fuzzy matching or display-name queries. Each result shows the actual `@username`, display name, and server nickname; check the actual username before selecting a similar-looking result.

Selection fills the Discord ID automatically. Fresh account creation also fills the current Discord username. Saving a user mapping retains the verified identity for future migrations and membership actions. A saved mapping's recipient is fixed in the migration preview; change it on **User mappings** instead of overriding it for one job. The bot rechecks the selected member before sensitive actions, so a search result does not bypass membership checks.

One verified Discord member can own three separate account slots. Choose slot 1, 2, or 3 in **User mappings** when the account names differ. Each slot can have one approved source and destination mapping. Account history remains separate; sharing the Discord owner does not merge the accounts or their data.

An advanced manual ID fallback remains available when you already know the member's ID. User mappings also allow a manual username label; a label alone is not a verified identity. Searching starts on interaction with the picker, so a bulk migration preview does not perform a Discord lookup for every user on opening. The slash command's `user:@member` selector also supplies the ID without manual entry.

Replies are ephemeral job statuses visible to the administrator. There is no automatic status polling; check the job with `/jellyport status` or the web page. New credentials are sent by DM only to the selected member. Users need to allow DMs from server members. Failed delivery leaves the new password available through the web app's one-time reveal for up to 24 hours. Existing Jellyfin passwords are not reset or sent by an ordinary migration.

## Choose event sources and intents

Privileged intents must be enabled both in the Developer Portal's Bot settings and through the corresponding Jellyport options. Slash commands and web member searches alone do not request these intents. Member search uses Discord's HTTP API and does not add a Server Members Intent requirement. Presence Intent is not needed. The role and message event requirements below are unchanged. See Discord's [Gateway intent documentation](https://docs.discord.com/developers/events/gateway#privileged-intents).

| Jellyport option | Developer Portal toggles | Purpose |
| --- | --- | --- |
| Commands and web member search only | No privileged intents | Admin account actions, member selection, and credential delivery |
| MEE6 message events | Message Content Intent and Server Members Intent | Read trusted announcements; resolve plain usernames against fresh member data |
| Membership role events | Server Members Intent | Observe active role additions/removals and member departures |

To read MEE6 announcements, set both `discord_subscription_channel_id` and `discord_subscription_bot_id`. Use the numeric ID of your subscription channel, such as `buried-treasure`, and the actual MEE6 bot user ID. Messages are accepted only from that bot account in that channel and server. Webhooks and other authors are ignored.

Only these anchored plain-text templates are recognized, allowing capitalization and spacing variations:

```text
Good news captain! @jlogan35 just subscribed to Sloop Crewman Plan!
Bad news captain! jlogan35  just cancelled their subscription.
```

An actual Discord mention such as `<@USER_ID>` is resolved by ID. A plain username must uniquely match a current member's exact Discord username; aliases are ignored. Unresolved identities are recorded for review and cannot trigger automatic account changes. Announcement text in embed titles or descriptions is not currently parsed. Other message formats need a parser update rather than being interpreted loosely.

Automatic tier changes require a new recognized announcement containing the plan name. A shared active-member role cannot identify whether someone pays for one, two, or three accounts. If MEE6 does not announce an upgrade or downgrade in the recognized format, apply the new tier through **Memberships**.

To observe membership role events, set `discord_member_role_id` to the role representing **currently entitled access**, then enable role events. Adding it produces a subscribe event; removing it or leaving the server produces an expire event for subscription-managed members. Complimentary access is exempt from these events. Configure MEE6's role behavior so this role remains active for the entire paid access period if you want expiration to follow that period.

## Review before enabling automatic actions

All automatic actions start disabled. Recognized events enter the web app's subscription queue, where you can apply or ignore them. An unresolved event requires a verified manual account action rather than an automatic username guess.

Configure membership tiers in Settings before enabling automatic provisioning. Defaults map `Sloop Crewman Plan` to one account, `Brigantine Crewman Plan` to two, and `Galleon Crewman Plan` to three. Plan names are matched exactly apart from capitalization and surrounding whitespace. Unknown plan names remain for review instead of being assigned an allowance. A generic membership role event does not identify a plan; it keeps a saved tier or uses an initial one-account tier for a new member. With no one-account tier configured, select the tier explicitly in the web app or an administrator command.

Enabling automatic provisioning applies resolved subscribe events to the member's account allowance. Each missing slot migrates its approved mapping or an exact matching Emby username, or creates a fresh Jellyfin account using the configured default account role or optional legacy template. Configure one of these defaults in Settings before provisioning. New numbered accounts use `_2` and `_3`; existing links and mapped names are preserved. Every new account has a separately generated password delivered to the same Discord owner.

An existing unmapped Jellyfin account requires an explicit **Users → Link Discord owner** association or an admin-approved migration to establish ownership first. Choose the actual Jellyfin account and verified Discord member rather than claiming an account from a matching name. The direct link does not change its password, policy, preferences, data, or disabled status. Once linked, returning members can regain access to the same accounts if Jellyport disabled them. Saving a mapping alone does not establish the lifecycle link; the approved migration or direct link does. Use **Memberships** to review and apply upgrades and downgrades manually, with automatic actions left disabled.

Downgrading disables extra slots and keeps all their data. Upgrading later can re-enable those same slots rather than replacing the accounts. Downgrades do not reset passwords or copy another user's history. Automatic subscription downgrades require both automatic provisioning and automatic disabling; with only automatic provisioning enabled, the downgrade remains for review. Manually approving the update applies the downgrade regardless of those switches.

Jellyport account roles are saved permission/preference presets, separate from Discord subscriber roles. The default account role supplies settings for new accounts, including shared server-backed Home preferences used by Web and compatible TV/mobile apps, and takes precedence over portable Emby preferences. Updating or assigning a saved account role does not automatically change existing members' settings; use the web interface to review and apply selected groups. Returning members keep their existing settings when access is restored. Automatic Discord subscription-tier-to-account-role mapping is not implemented. See [account roles and defaults](../README.md#account-roles-and-defaults).

Enabling automatic disabling applies expire events to every linked account slot. Cancellation announcements remain for review by default: cancelling renewal does not establish when paid access ends. The separate “disable on cancellation” option also applies cancellations immediately when automatic disabling is enabled. Manually applying a cancellation event disables all of a subscription-managed member's linked account slots immediately, regardless of that automatic-action option. Complimentary members are exempt even when an old queued billing event is applied manually.

An applied cancellation remains a hold even if MEE6 leaves the member's active role in place. Routine role reconciliation cannot undo it. A new recognized subscription event, a fresh role-add event, or an administrator's membership update can restore the entitled accounts.

Disabling changes account access while preserving passwords and watched history. Jellyfin administrators and any selected legacy template user are protected. Accounts disabled independently by an administrator are not automatically re-enabled. Missing or changed links and unavailable membership checks are recorded for review instead of assuming an account may be changed.

Jellyport does not query MEE6 billing, determine paid-through dates, or recover old announcement messages. With role events enabled, it reconciles linked memberships on startup/reconnect and every five minutes, using current membership rather than replaying old changes. It can detect missing roles and departed linked users after downtime. With automatic provisioning also enabled, it scans current active-role members for unlinked subscribers, including members who joined during downtime. Enabling this combination can provision **all current active-role members without an identity link**, so check that role's membership first. With only message events enabled, announcements missed while the app was offline require a new recognized event or an administrator action.

Discord IDs are the durable link; usernames can change. Lifecycle actions keep using the saved Jellyfin account and do not rename it. Use a verified mapping for legacy username mismatches, and inspect stale queued events before applying them. Mapping edits invalidate queued migrations using an older revision instead of redirecting their data or credentials.

## Complimentary members and accounts without Discord

Use **Memberships → Access policy → Complimentary · admin managed** for non-paying Discord members. Select them using the server member search and choose an allowance of 1–3 accounts. They do not need the configured active subscriber role. Complimentary media access is never revoked by MEE6 cancellation, subscription expiry, a missing paid role, or departure from Discord; only administrator-controlled account actions change it. A current guild membership is still required to deliver credentials or perform bot commands for that recipient.

**Save access policy** records the billing exemption and allowance without making media account changes. This also covers family members who currently have only Emby accounts. **Review membership update** separately reviews account names, migrations or creations, restored slots, and extras to disable. Confirmation saves the selected policy and queues the reviewed account changes. Do not use a paid tier to represent a complimentary member.

For an Emby-only owner, use **User mappings** to choose their actual source account, destination name, verified Discord owner, and slot. For an existing Jellyfin-only owner, use **Users → Link Discord owner** after saving their complimentary policy. No passwords are reset by direct linking.

Accounts for children or anyone without Discord are supported independently. Leave the Discord field blank when creating or migrating them. Their access remains administrator managed, and newly generated credentials are available through the web app's one-time reveal for up to 24 hours. Discord searches and billing checks are not required for these accounts.

## Organize owners with Discord roles

Use **Users → Discord organization roles** to tag confirmed owners according to their media accounts. This is separate from subscriber roles and does not enable, disable, or grant media access. Role tags count existing accounts, including disabled ones, so they organize your users rather than report active subscriptions.

1. Create dedicated informational roles in Discord with no server permissions, such as `Emby only` and `Jellyfin`. Do not use them in channel permission overwrites. Jellyport checks guild-level role permissions but does not query channel overwrites, which can independently affect Discord channel access.
2. Give Jellyport's bot Manage Roles and place its highest role above both organization roles. If Manage Roles is missing, use **Users → Update bot permissions** to open the generated invite requesting this permission before selecting roles. The app lists existing roles and marks unsafe or unmanageable choices unavailable. It refuses managed roles, subscriber/admin roles, and roles with server permissions. Discord's [role hierarchy rules](https://docs.discord.com/developers/topics/permissions#permission-hierarchy) apply to bot-managed roles.
3. Select the roles from Jellyport's dropdowns and save. When organization roles are configured, the generated invite requests Manage Roles in addition to its normal permissions; use the updated invite or update the bot's guild permissions.
4. Preview the proposed additions and removals, then apply them. No member IDs or individual role IDs need to be entered for these steps.

By default, the Emby role is reserved for owners with Emby accounts and no Jellyfin account. Owners with Jellyfin accounts receive the Jellyfin role even when they still use both servers. Turn off **Reserve the Emby role for owners who have only Emby accounts** to reflect both server accounts with both roles.

Tags use only confirmed ownership from durable links and approved user mappings. A same-name pairing in the user directory is for display and is not an approved ownership link. Unlinked accounts are skipped until you confirm their owner. Users without Discord remain visible in the directory and need no role tag. Confirmed former Discord members are skipped while synchronization continues for current members; their saved account links and media access are preserved. Unknown Discord API failures still stop synchronization.

Previews expire after five minutes and are single-use. Changed configuration, account associations, or reviewed role state require a fresh preview. Applying a preview changes only the configured organization roles; subscriber roles and unrelated roles are preserved. Missing media API credentials, unavailable servers, or failed Discord checks stop synchronization instead of interpreting unavailable data as no accounts.

Automatic role synchronization is off by default and can be enabled separately from subscription provisioning or disabling. When enabled, it checks the current confirmed owners every five minutes. Organization-role changes do not become subscription events and never determine billing entitlement. Keep the manual preview workflow until you have checked the account associations and role behavior.

## MEE6 and Stripe access

A documented public MEE6 billing API has not been identified. The current integration uses trusted Discord announcements and membership roles. A future Stripe integration must first verify that your connected account grants API/webhook access to the necessary subscriptions and provides a reliable Discord identity link.

[MEE6 documents](https://mee6bot.freshdesk.com/support/solutions/articles/101000472733-server-owner-how-to-see-information-about-subscribers-on-stripe) subscriber details for Standard Stripe accounts, including Discord IDs in the initial Checkout Session request logs. Those logs may be retained for only one year. Express account owners are directed to contact MEE6. Dashboard visibility alone does not confirm API access. Reliable billing events could support tier-specific permissions, paid-through dates, and renewal grace periods; Jellyport does not implement those billing features yet.
