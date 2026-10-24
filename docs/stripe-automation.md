# Stripe membership automation

Stripe can be Jellyport's billing source without MEE6. The Stripe connection remains read-only: Jellyport never creates charges, changes subscriptions, cancels payments, or writes customer data. Media account changes are separate administrator-controlled Jellyport actions.

The existing review-only connection remains the default. Saving a key, mapping prices, approving identity links, or enabling periodic billing refresh does not enable membership automation.

## Setup

1. Connect Jellyfin and Discord and enable the bot's **Server Members Intent** in the Discord Developer Portal. For media-account provisioning, also configure an account default role or template. Role cleanup does not require a media account for each member. Emby is needed only when migrating existing Emby users. Message Content Intent is optional when trusted messages are off.
2. In **Settings → Automation → Membership automation**, select **Stripe** as the subscription source and save. Trusted subscription messages and MEE6 subscriber roles are optional in this mode. Current human Discord-server membership is still required for credential delivery.
3. Create a restricted live Stripe key. Give **Read** access to **Customers, Products, Prices, Subscriptions, Checkout Sessions, and Invoices**. Keep every other resource at **None**. Never grant Write access. Review-only connections can continue using the original five resources without Invoices.
4. Enter the key in **Settings → Stripe**, save, then choose **Test & sync Stripe**. Do not paste a key into chat, documentation, Compose files, or a public repository.
5. Map Stripe prices to Jellyport membership tiers and approve customer-to-Discord identities. Names, emails and metadata are suggestions, not ownership proof. An unlinked paying customer requires administrator identity review before automation can act.
6. Enable **Use verified Stripe billing for membership automation** and save. This records the subscriptions already present as the activation baseline. Enabling never bulk creates accounts for existing subscribers.
7. Enable the separate Jellyport automatic provisioning and/or disabling switches for the actions you want. Automatic creation for genuinely new subscribers also requires its own switch. Leave these off while reviewing associations. Enable the fifteen-minute Stripe refresh for continuing management.

Changing a key, Discord server, paired media-server identity or selected billing source invalidates the old automation scope. Sync and review the new connection before enabling it again. Test-mode Stripe data never drives production membership changes.

Stripe documents [restricted-key permissions](https://docs.stripe.com/keys/restricted-api-keys). The current API boundary uses `2025-06-30.basil`; all requests are bounded GETs with serial rate limiting, cancellation, timeouts and backoff.

## What counts as entitlement

Jellyport checks the newest paid invoice for each approved subscription. It requires a complete invoice with one non-proration subscription line, quantity one, and matching customer, subscription and configured price. The invoice must be paid with no remaining amount. Its subscription-line service period determines the paid-through time; the invoice's general `period_end` does not.

This follows Stripe's [invoice object](https://docs.stripe.com/api/invoices/object?api-version=2025-06-30.basil), [subscription line period](https://docs.stripe.com/api/invoice-line-item/object?api-version=2025-06-30.basil), and [newest-first invoice listing](https://docs.stripe.com/api/invoices/list?api-version=2025-06-30.basil). A subscription's `active` status alone is insufficient, particularly with invoice collection or delayed payment methods. See Stripe's [subscription lifecycle](https://docs.stripe.com/billing/subscriptions/overview).

Paying an overdue invoice settles its original service period; the payment date does not start a new access period. If payment retries already ended the subscription, paying that old invoice does not restore subscriber status or reactivate media accounts. Jellyport checks the current subscription status and the original invoice-line period on every billing refresh, including when it missed the cancellation before the late payment. A genuinely active replacement subscription with a current verified paid period can restore eligible existing accounts without resetting their passwords or repeating their welcome messages. Stripe documents that [a canceled subscription cannot be reactivated](https://docs.stripe.com/billing/subscriptions/cancel#stop-a-pending-cancellation).

For new account creation, the subscription must be outside the activation baseline, created after activation, and no more than 48 hours old. Existing Discord members may qualify after a verified new payment. Existing media accounts, approved mappings, prior membership choices and unresolved automatic enrollments still require explicit Jellyfin opt-in. A recent paid subscription does not automatically migrate Emby history.

Every account receives separate credentials and keeps its own history. The bot privately messages the verified owner. Blocked DMs are reported without automatically repeating account creation. Existing passwords are never reset merely to deliver a message.

## Expiry and exceptions

Automatic expiry requires every subscription belonging to every approved customer for that Discord owner to be conclusively ended, with a verified paid period already past. The supported end states are `canceled` and `incomplete_expired` with an effective end timestamp. A never-paid expired signup has no verified paid period and remains for review.

Scheduling cancellation does not disable access early. Any active, trialing, past-due, unpaid, paused, unknown, unmapped or unverifiable subscription prevents automatic expiry. Multiple simultaneous active subscriptions, quantity bundles, proration-only invoices and invoices with multiple or truncated lines require review. Jellyport does not add account allowances from multiple payments.

Read failures and stale billing evidence preserve existing access. Whole-member complimentary access and individually flagged Family accounts retain their existing protections. Unlinked media accounts are never automatically disabled. Administrators can still make an explicit access decision after reviewing billing.

MEE6 or the server administrator continues assigning paid Discord roles and handling ordinary cancellation cleanup. The optional backstop below removes roles left behind after verified expiry. Jellyport's Emby/Jellyfin organization tags describe account ownership, including disabled accounts, and are not proof of a current subscription. A retained or newly re-added MEE6 role cannot automatically reactivate media access while Stripe is selected as the billing authority; that non-Stripe event remains for explicit review. See [Discord organization roles](discord-setup.md#organize-owners-with-discord-roles).

This is conservative invoice-backed access management, not a complete accounting or refund ledger. Disputes, refunds, unusual credits and custom invoice arrangements require administrator review. No payment-method or charge permissions are requested.

## Subscriber role cleanup backstop

This policy is off by default and separate from media-account automation. Keep MEE6's initial role assignment and normal cancellation cleanup enabled. Jellyport never adds subscriber roles, restores roles after an invoice payment, kicks a member, or changes a media account through this worker.

1. Select **Stripe** as the subscription source under **Settings → Automation**. This also keeps ordinary Discord role events from automatically changing media access. The separate verified membership automation, account provisioning and disabling switches can remain off.
2. Give the restricted live Stripe key **Invoices Read** in addition to the five connection permissions, then complete **Test & sync Stripe**. Approve the actual customer-to-Discord identities and map the relevant prices to membership tiers. An unlinked customer or an unknown price is never an automatic cleanup target.
3. Give the Jellyport bot **Manage Roles** and place its highest role above the subscriber and tier roles it may remove. If needed, **Users → Discord organization roles → Update bot permissions** opens the existing invite with Manage Roles. An administrator role is unnecessary. [Discord requires Manage Roles](https://docs.discord.com/developers/resources/guild#remove-guild-member-role) for individual role removal and enforces its [role hierarchy](https://docs.discord.com/developers/topics/permissions#permission-hierarchy).
4. Open **Settings → Stripe → Role cleanup**. Enable the shared fifteen-minute billing refresh, select only the subscriber/tier roles that represent paid access, enable automatic cleanup, and save. Select the common active-subscriber role as well as individual tier roles if both grant access. Up to 20 distinct roles are supported; unrelated, Family, complimentary and community roles must stay unselected. Managed roles, administrator/organization roles, roles with moderation or unknown permissions, and roles at or above the bot are unavailable.
5. Choose **Test & sync Stripe** to obtain new paid-period evidence. Enabling probes invoice permission but does not adopt old observations as removal authority. The next complete verified sync supplies the cleanup decisions.

Cleanup requires every subscription for every approved customer belonging to the Discord member to meet the same conclusive expiry rules above. A genuinely active paid replacement preserves roles. Paying an overdue invoice after cancellation never establishes a new entitlement: its original service period and the subscription's current status still govern access. Stripe likewise requires an [active subscription when granting access after payment](https://docs.stripe.com/billing/subscriptions/webhooks).

Whole-member complimentary policies and all approved identity-review exceptions protect the member's roles. A manually flagged Family account on either server also protects the entire confirmed Discord owner because a Discord role cannot be removed for only one household slot. Family ownership must come from an approved account association, mapping or lifecycle link; matching names are insufficient. Keep these annotations current before enabling cleanup.

Billing refreshes share one bounded serial invoice-reading pass with membership automation. Cleanup rechecks current roles every five minutes using verified billing evidence no older than thirty minutes; failed or incomplete billing reads invalidate that evidence and preserve roles. Each pass processes at most 25 members and 25 individual role removals, yields between writes and stops starting work after its one-minute budget. Large backlogs continue on later passes. No media catalog or watch history is read.

The same tab shows recent outcomes, failed members, and roles observed returning after a confirmed removal. A returning role pauses cleanup for that member instead of repeatedly fighting MEE6. Transport or permission failures retry with bounded backoff and pause after three failed attempts. Fix the connection, role hierarchy or competing automation, then disable and save the policy and explicitly enable it again before a fresh sync to retry paused work. A genuinely verified paid renewal also starts a new access cycle, so a later real expiry can be cleaned up normally.

Reports and uncertain-removal receipts are encrypted locally; the latest 200 reports are retained. They are visible to signed-in Jellyport administrators on this tab, not posted to Discord or included in credential messages. After restart, cleanup waits for a fresh verified billing sync and reads current roles before resolving interrupted removals. Key, guild, paired-server or relevant bot-policy changes invalidate the old cleanup activation; review and enable it for the new connection. Turning off periodic Stripe refresh also turns off cleanup. No compose changes or Stripe Write permissions are needed.

## Recovery and visibility

Membership events and linked jobs show account-action results. **Settings → Stripe** separately shows paid-period verification errors and billing actions needing review. Resolving a failed billing read does not replay an uncertain account-creation action.

Jellyport durably claims an event before invoking membership work. Claimed work is not repeated after a restart. The existing encrypted pending-enrollment guard survives deleted activity reports and requires explicit administrator approval after uncertain or failed creation. Completed slots and newer administrator decisions are preserved. Billing evidence is rechecked before sensitive media writes and expires after thirty minutes without a successful verification.

Automation keeps at most 10,000 durable event receipts per activation policy. Reaching that bound stops additional automatic actions for review rather than forgetting uncertain work or silently replaying it. Native Stripe observations and manual administrator actions remain available.
