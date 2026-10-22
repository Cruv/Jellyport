import { useState } from 'react';
import { Heading } from './components';
import IdentityReviewPanel from './IdentityReviewPanel';
import MembershipsPage from './MembershipsPage';
import { useRouteTab } from './routing';
import { SubscriptionsPage } from './WorkspacePages';
import { TabPanel, Tabs } from './ui-layout';
import type { Api, Job, Notify, Page, Settings, SubscriptionEvent } from './types';

/** One workspace for reviewed identities, access policy and incoming membership events. */
export default function MemberManagementPage({
  settings,
  api,
  notify,
  created,
  demo,
  events,
  refresh,
  navigate,
  openJob,
  review,
  ignore,
  busy,
}: {
  settings: Settings;
  api: Api;
  notify: Notify;
  created: (job: Job) => void;
  demo: boolean;
  events: SubscriptionEvent[];
  refresh: () => void;
  navigate: (page: Page) => void;
  openJob: (id: string) => void;
  review: (event: SubscriptionEvent) => void;
  ignore: (event: SubscriptionEvent) => void;
  busy: boolean;
}) {
  const [identityVersion, setIdentityVersion] = useState(0);
  const [tab, setTab] = useRouteTab('memberships');
  const attention = events.filter((event) => ['pending', 'failed'].includes(event.status)).length;
  return (
    <div className="page-stack">
      <Heading
        title="Memberships"
        description="Connect identities, review access gaps, and manage paid or complimentary membership. Jellyfin is optional."
      />
      <Tabs
        id="member-management"
        label="Membership sections"
        tabs={[
          { id: 'overview', label: 'Identity & gaps' },
          { id: 'accounts', label: 'Accounts & access' },
          { id: 'events', label: 'Events', count: attention },
        ]}
        value={tab}
        onChange={setTab}
      />
      <TabPanel id="member-management" tabId="overview" active={tab === 'overview'}>
        {tab === 'overview' && (
          <IdentityReviewPanel
            api={api}
            notify={notify}
            demo={demo}
            active
            onApplied={() => setIdentityVersion((value) => value + 1)}
          />
        )}
      </TabPanel>
      <TabPanel id="member-management" tabId="accounts" active={tab === 'accounts'}>
        <MembershipsPage
          settings={settings}
          api={api}
          notify={notify}
          created={created}
          refreshKey={identityVersion}
          embedded
        />
      </TabPanel>
      <TabPanel id="member-management" tabId="events" active={tab === 'events'}>
        <SubscriptionsPage
          events={events}
          refresh={refresh}
          navigate={navigate}
          openJob={openJob}
          review={review}
          ignore={ignore}
          busy={busy}
          embedded
        />
      </TabPanel>
    </div>
  );
}
