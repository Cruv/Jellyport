# Stripe membership automation

Stripe can be Jellyport's billing source without MEE6. The Stripe connection remains read-only: Jellyport never creates charges, changes subscriptions, cancels payments, or writes customer data. Media account changes are separate administrator-controlled Jellyport actions.

The existing review-only connection remains the default. Saving a key, mapping prices, approving identity links, or enabling periodic billing refresh does not enable membership automation.

## Setup

1. Connect Jellyfin and Discord, enable the bot's **Server Members Intent** in the Discord Developer Portal, and configure an account default role or template. Emby is needed only when migrating existing Emby users. Message Content Intent is optional when trusted messages are off.
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

For new account creation, the subscription must be outside the activation baseline, created after activation, and no more than 48 hours old. Existing Discord members may qualify after a verified new payment. Existing media accounts, approved mappings, prior membership choices and unresolved automatic enrollments still require explicit Jellyfin opt-in. A recent paid subscription does not automatically migrate Emby history.

Every account receives separate credentials and keeps its own history. The bot privately messages the verified owner. Blocked DMs are reported without automatically repeating account creation. Existing passwords are never reset merely to deliver a message.

## Expiry and exceptions

Automatic expiry requires every subscription belonging to every approved customer for that Discord owner to be conclusively ended, with a verified paid period already past. The supported end states are `canceled` and `incomplete_expired` with an effective end timestamp. A never-paid expired signup has no verified paid period and remains for review.

Scheduling cancellation does not disable access early. Any active, trialing, past-due, unpaid, paused, unknown, unmapped or unverifiable subscription prevents automatic expiry. Multiple simultaneous active subscriptions, quantity bundles, proration-only invoices and invoices with multiple or truncated lines require review. Jellyport does not add account allowances from multiple payments.

Read failures and stale billing evidence preserve existing access. Whole-member complimentary access and individually flagged Family accounts retain their existing protections. Unlinked media accounts are never automatically disabled. Administrators can still make an explicit access decision after reviewing billing.

This is conservative invoice-backed access management, not a complete accounting or refund ledger. Disputes, refunds, unusual credits and custom invoice arrangements require administrator review. No payment-method or charge permissions are requested.

## Recovery and visibility

Membership events and linked jobs show account-action results. **Settings → Stripe** separately shows paid-period verification errors and billing actions needing review. Resolving a failed billing read does not replay an uncertain account-creation action.

Jellyport durably claims an event before invoking membership work. Claimed work is not repeated after a restart. The existing encrypted pending-enrollment guard survives deleted activity reports and requires explicit administrator approval after uncertain or failed creation. Completed slots and newer administrator decisions are preserved. Billing evidence is rechecked before sensitive media writes and expires after thirty minutes without a successful verification.

Automation keeps at most 10,000 durable event receipts per activation policy. Reaching that bound stops additional automatic actions for review rather than forgetting uncertain work or silently replaying it. Native Stripe observations and manual administrator actions remain available.
