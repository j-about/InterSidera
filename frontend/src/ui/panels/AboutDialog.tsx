import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { CREDITS } from '../../data/credits';
import type { CreditEntry } from '../../data/credits';
import { REPOSITORY_URL } from '../../data/repository';
import type { MetaResponse, SkyStore } from '../../state/storeTypes';
import Dialog from '../components/Dialog';

// The About screen (INFO-4, brief l.233, l.326; plan D110): the application, server and API
// versions, the repository link, the data this server serves (`/meta.catalogs.*.license` and
// `.attribution`, the geocoder attribution) and the credits of every registered data source and
// asset from `credits.json` (generated from the same registry as `THIRD_PARTY_NOTICES.md`).
// Headings are translated; the attribution strings, licenses and URLs are data and stay as
// they are. External links open in a new tab, announced as such (UX-4), and stand as
// `inline-block` boxes of at least 24 px (WCAG 2.2 SC 2.5.8 target size, plan D157 C4): alone in
// a `dd` they are not "in a sentence", so the inline exception does not apply to them.

export interface AboutDialogProps {
  store: SkyStore;
}

interface ExternalLinkProps {
  href: string;
  children: ReactNode;
}

function ExternalLink({ href, children }: ExternalLinkProps) {
  const { t } = useTranslation();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block min-h-6 py-1 break-all text-accent underline-offset-2 hover:underline"
    >
      {children}
      <span className="sr-only"> ({t('about.newTab')})</span>
    </a>
  );
}

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="shrink-0 text-muted sm:w-40">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function CreditCard({ entry }: { entry: CreditEntry }) {
  const { t } = useTranslation();
  const title = entry.filename ?? entry.key;
  return (
    <article className="flex flex-col gap-1 border-t border-muted/30 pt-2 text-xs">
      <h4 className="text-sm font-medium">
        {title}
        {title !== entry.key && <span className="text-muted"> ({entry.key})</span>}
      </h4>
      <dl className="flex flex-col gap-0.5">
        {entry.filename !== null && entry.filename !== title && (
          <Field label={t('about.file')}>{entry.filename}</Field>
        )}
        {entry.url !== null && (
          <Field label={t('about.source')}>
            <ExternalLink href={entry.url}>{entry.url}</ExternalLink>
          </Field>
        )}
        {entry.fallback_urls.length > 0 && (
          <Field label={t('about.mirrors')}>
            <ul className="flex flex-col">
              {entry.fallback_urls.map((url) => (
                <li key={url}>
                  <ExternalLink href={url}>{url}</ExternalLink>
                </li>
              ))}
            </ul>
          </Field>
        )}
        {entry.version_or_date !== null && (
          <Field label={t('about.versionOrDate')}>{entry.version_or_date}</Field>
        )}
        {entry.license !== null && <Field label={t('about.license')}>{entry.license}</Field>}
        {entry.copyright !== null && <Field label={t('about.copyright')}>{entry.copyright}</Field>}
        {entry.attribution !== null && (
          <Field label={t('about.attribution')}>{entry.attribution}</Field>
        )}
        {entry.notes !== null && <Field label={t('about.notes')}>{entry.notes}</Field>}
      </dl>
      {entry.license_text !== null && (
        <details>
          <summary className="cursor-pointer text-muted">{t('about.licenseText')}</summary>
          <pre className="max-h-64 overflow-auto rounded-md bg-field-bg p-2 text-[0.7rem] leading-snug whitespace-pre-wrap">
            {entry.license_text}
          </pre>
        </details>
      )}
    </article>
  );
}

/** The served catalogs of `/meta.catalogs` with their translated heading (absent ones skipped). */
function servedCatalogs(
  meta: MetaResponse,
  t: (
    key:
      | 'about.catalogStars'
      | 'about.catalogDso'
      | 'about.catalogConstellations'
      | 'about.catalogMinor',
  ) => string,
): { name: string; license: string; attribution: string }[] {
  const rows: { name: string; license: string; attribution: string }[] = [];
  const { stars, dso, constellations, minor_bodies: minor } = meta.catalogs;
  rows.push({
    name: t('about.catalogStars'),
    license: stars.license,
    attribution: stars.attribution,
  });
  if (dso !== undefined && dso !== null) {
    rows.push({ name: t('about.catalogDso'), license: dso.license, attribution: dso.attribution });
  }
  if (constellations !== undefined && constellations !== null) {
    rows.push({
      name: t('about.catalogConstellations'),
      license: constellations.license,
      attribution: constellations.attribution,
    });
  }
  if (minor !== undefined && minor !== null) {
    rows.push({
      name: t('about.catalogMinor'),
      license: minor.license,
      attribution: minor.attribution,
    });
  }
  return rows;
}

export default function AboutDialog({ store }: AboutDialogProps) {
  const { t } = useTranslation();
  const { open, meta, serverVersion } = useStore(
    store,
    useShallow((s) => ({
      open: s.ui.dialog === 'about',
      meta: s.meta,
      serverVersion: s.health?.version ?? null,
    })),
  );
  const served = meta === null ? [] : servedCatalogs(meta, t);
  return (
    <Dialog
      open={open}
      title={t('about.title')}
      onClose={() => {
        const { ui, actions } = store.getState();
        if (ui.dialog === 'about') {
          actions.closeDialog();
        }
      }}
    >
      <div className="flex flex-col gap-4 pt-3 text-sm">
        <dl className="flex flex-col gap-0.5">
          <Field label={t('about.appVersion')}>{__APP_VERSION__}</Field>
          <Field label={t('about.serverVersion')}>{serverVersion ?? '—'}</Field>
          <Field label={t('about.apiVersion')}>{meta?.api_version ?? '—'}</Field>
        </dl>
        <p>
          <ExternalLink href={REPOSITORY_URL}>{t('about.repository')}</ExternalLink>
        </p>
        {meta !== null && (
          <section aria-labelledby="about-served-title" className="flex flex-col gap-2">
            <h3 id="about-served-title" className="text-base font-semibold">
              {t('about.serverData')}
            </h3>
            <dl className="flex flex-col gap-1 text-xs">
              {served.map((row) => (
                <Field key={row.name} label={row.name}>
                  <span>{row.attribution}</span>
                  <span className="text-muted"> — {row.license}</span>
                </Field>
              ))}
              <Field label={t('about.geocoder')}>{meta.geocoder.attribution}</Field>
            </dl>
          </section>
        )}
        <section aria-labelledby="about-credits-title" className="flex flex-col gap-2">
          <h3 id="about-credits-title" className="text-base font-semibold">
            {t('about.credits')}
          </h3>
          {CREDITS.map((entry) => (
            <CreditCard key={entry.key} entry={entry} />
          ))}
        </section>
      </div>
    </Dialog>
  );
}
