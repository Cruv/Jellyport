import changelog from '../../CHANGELOG.md?raw';
import { readReleaseNotes } from '../../scripts/changelog.mjs';
import { Modal } from './components';

const repository = 'https://github.com/Cruv/Jellyport';
const releaseDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' });

export default function ChangelogDialog({
  version,
  revision,
  close,
}: {
  version: string;
  revision?: string;
  close: () => void;
}) {
  const release = readReleaseNotes(changelog, version);
  const build = revision && /^[a-f0-9]{40}$/.test(revision) ? revision : undefined;

  return (
    <Modal
      title="Changelog"
      close={close}
      footer={
        <button type="button" className="btn btn-quiet" onClick={close}>
          Close
        </button>
      }
    >
      <div className="form-stack">
        <section className="form-stack" aria-label={`Version v${version}`}>
          <h3>v{version}</h3>
          {release ? (
            <>
              <p className="subtle">
                Released{' '}
                <time dateTime={release.date}>{releaseDate.format(new Date(release.date))}</time>
              </p>
              <a
                href={`${repository}/releases/tag/v${version}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub release for v{version}
              </a>
            </>
          ) : (
            <p className="subtle">Release notes unavailable for this version.</p>
          )}
        </section>
        {build && (
          <section className="form-stack" aria-label="Running build">
            <h3>Running build</h3>
            <a
              className="mono release-revision"
              href={`${repository}/commit/${build}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {build}
            </a>
          </section>
        )}
        {release && (
          <ul className="release-changes">
            {release.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
        <a href={`${repository}/releases`} target="_blank" rel="noopener noreferrer">
          All GitHub releases
        </a>
      </div>
    </Modal>
  );
}
