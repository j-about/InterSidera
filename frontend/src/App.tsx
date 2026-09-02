import { useTranslation } from 'react-i18next';

// M0 placeholder: static, no fetch, no engine (plan D21). Every visible string goes through `t()`
// so `scripts/check_i18n.mjs` has real keys to verify (brief l.411).
export default function App() {
  const { t } = useTranslation();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sky-bg text-sky-fg">
      <h1 className="text-4xl font-semibold tracking-wide">{t('app.title')}</h1>
      <p className="mt-3 px-4 text-center text-lg opacity-80">{t('app.tagline')}</p>
    </main>
  );
}
