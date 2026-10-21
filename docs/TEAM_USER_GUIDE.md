# GovCheck: team access and G2X

Open [GovCheck](https://govcheck-srpr.onrender.com).

## Add a teammate

1. Sign in with your administrator account.
2. Open **Team Management** in the left sidebar.
3. In **Invite a colleague**, enter the person's name and exact `@savangroup.com` work email.
4. Choose a role: **Member** for claiming and working assigned opportunities; **Manager** for assigning team work; **Viewer** for reading only; **Admin** for managing access and application settings.
5. Select **Send invitation** and share the GovCheck URL with the colleague.
6. They enter their invited email on the sign-in page, request a code if needed, and use the newest emailed code. Password setup is optional.

Only invited, active members with an allowed email domain can sign in. A Savan email alone does not grant membership. GovCheck blocks outside-domain invitation, code, login and recovery requests. Subdomains and lookalikes such as `savangroup.com.example.org` do not qualify. Admins can resend codes, change roles or deactivate people in the member list.

On an unowned opportunity, a Member can choose **Assign to me**, add tags and notes, and find the item under **My Work**. Managers can assign owners and collaborators. Members cannot take an item away from its current owner.

## Use G2X

1. Sign in to GovCheck and open **Integration settings**.
2. Select **Connect G2X**, sign in to your own G2X account, and approve the requested connection. You will return to GovCheck.
3. Choose a **Read-only research tool**. Available tools depend on your G2X account and entitlements.
4. Expand **Required tool input schema**. Enter a JSON object with that tool's required field names and values in **Research inputs as JSON**. The current interface uses tool-specific JSON inputs. For example, choose an appropriate tool to investigate the buyer, incumbent, award history or supporting documents for an opportunity. Do not assume every tool accepts a `query` field; follow its schema.
5. Select **Run individual research**. Review the returned records and source links.
6. Use **Clear research results** when finished, or **Disconnect G2X** to remove the saved connection credentials.

Each person connects their own G2X account. Results remain personal and temporary on that page. They are not automatically saved into opportunities, shared with teammates, used for scheduled data feeds, or sent to GovCheck's AI report generator. The independent authored notes you write in GovCheck remain separate from provider content.

If sign-in expires, reconnect. An entitlement/access error must be resolved with G2X for that account; a rate-limit error means wait before retrying. See the [G2X tool reference](https://g2x.com/mcp/tools).

## Access boundary

The domain and invitation checks are enforced by GovCheck's server on login and authenticated requests. Neon's managed public identity service has separate signup behavior; creating a Neon identity does not create GovCheck membership or grant access to procurement records.
