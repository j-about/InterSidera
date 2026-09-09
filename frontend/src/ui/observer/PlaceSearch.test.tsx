import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import type { searchPlaces } from '../../api/geocoder';
import { GeocoderBlockedError } from '../../api/geocoder';
import { createSkyStore } from '../../state/store';
import type { GeocoderResult } from '../../state/types';
import { makeMeta } from '../../test/meta';
import PlaceSearch, { OSM_COPYRIGHT_URL } from './PlaceSearch';

// The Nominatim panel: submit-only through the injected `geocode`, one request at a time and
// none before the policy interval, the results as buttons writing the observer, the errors as
// alerts, the attribution and its link, the toggle hiding the form, the server disable hiding all.

const PARIS: GeocoderResult = {
  placeId: 1,
  displayName: 'Paris, Île-de-France, France',
  lat: 48.8588897,
  lon: 2.320041,
  category: 'boundary',
  type: 'administrative',
};

type Geocode = typeof searchPlaces;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('PlaceSearch', () => {
  it('submits the typed text once with the language and email, lists results and picks one', async () => {
    const store = createSkyStore({ lang: 'fr' });
    store.getState().actions.setMeta(
      makeMeta({
        geocoder: {
          enabled: true,
          url: 'https://nominatim.example.test',
          email: 'ops@example.test',
          attribution: 'Geocoding: (c) OpenStreetMap contributors, via Nominatim',
          min_interval_ms: 1000,
        },
      }),
    );
    const pending = deferred<GeocoderResult[]>();
    const geocode = vi.fn<Geocode>(() => pending.promise);
    let now = 10_000;
    render(<PlaceSearch store={store} geocode={geocode} now={() => now} />);

    // The store's language reaches the request; the rendered labels follow i18next (English here).
    const input = screen.getByRole('textbox', { name: 'Place name' });
    fireEvent.change(input, { target: { value: '  Paris ' } });
    fireEvent.submit(input.closest('form') ?? input);
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledWith('Paris', {
      baseUrl: 'https://nominatim.example.test',
      lang: 'fr',
      email: 'ops@example.test',
    });
    expect(store.getState().geocoder).toMatchObject({ busy: true, lastRequestMs: 10_000 });
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('aria-disabled', 'true');
    // A second submit while the request is in flight is dropped.
    fireEvent.submit(input.closest('form') ?? input);
    expect(geocode).toHaveBeenCalledTimes(1);

    pending.resolve([PARIS]);
    await flush();
    expect(store.getState().geocoder).toMatchObject({ busy: false, results: [PARIS], error: null });
    const result = screen.getByRole('button', { name: PARIS.displayName });
    fireEvent.click(result);
    expect(store.getState().observer).toEqual({
      body: 'earth',
      lat: PARIS.lat,
      lon: PARIS.lon,
      elev: 0,
    });

    // The policy interval: nothing leaves before a second has passed since the last request.
    now = 10_500;
    fireEvent.submit(input.closest('form') ?? input);
    expect(geocode).toHaveBeenCalledTimes(1);
    now = 11_000;
    fireEvent.submit(input.closest('form') ?? input);
    expect(geocode).toHaveBeenCalledTimes(2);

    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: i18next.t('geocoder.attributionLink') });
    expect(link).toHaveAttribute('href', OSM_COPYRIGHT_URL);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('ignores an empty query, omits the email when absent and reports no results', async () => {
    const store = createSkyStore();
    store.getState().actions.setMeta(makeMeta());
    const geocode = vi.fn<Geocode>(() => Promise.resolve([]));
    render(<PlaceSearch store={store} geocode={geocode} now={() => 5_000} />);
    const input = screen.getByRole('textbox', { name: 'Place name' });
    fireEvent.submit(input.closest('form') ?? input);
    expect(geocode).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Nowhere' } });
    fireEvent.submit(input.closest('form') ?? input);
    expect(geocode).toHaveBeenCalledWith('Nowhere', {
      baseUrl: 'https://nominatim.example.test',
      lang: 'en',
    });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(i18next.t('geocoder.no_results'));
  });

  it('translates a failure and keeps the button usable once the interval has passed', async () => {
    const store = createSkyStore();
    store.getState().actions.setMeta(makeMeta());
    const geocode = vi.fn<Geocode>(() => Promise.reject(new GeocoderBlockedError(429)));
    let now = 1_000;
    render(<PlaceSearch store={store} geocode={geocode} now={() => now} />);
    const input = screen.getByRole('textbox', { name: 'Place name' });
    fireEvent.change(input, { target: { value: 'Paris' } });
    fireEvent.submit(input.closest('form') ?? input);
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(i18next.t('geocoder.blocked'));
    expect(store.getState().geocoder).toMatchObject({ busy: false, error: 'blocked', results: [] });
    now = 2_500;
    act(() => {
      store.getState().actions.setGeocoder({});
    });
    expect(screen.getByRole('button', { name: 'Search' })).not.toHaveAttribute('aria-disabled');
  });

  it('hides the form behind the toggle and the whole section when the server disables it', () => {
    const store = createSkyStore();
    store.getState().actions.setMeta(makeMeta());
    const view = render(<PlaceSearch store={store} geocode={vi.fn<Geocode>()} />);
    const toggle = screen.getByRole('switch', { name: 'Online place search (Nominatim)' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(store.getState().geocoder.enabled).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    // The attribution stays.
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    view.unmount();

    const disabled = createSkyStore();
    disabled
      .getState()
      .actions.setMeta(
        makeMeta({ geocoder: { enabled: false, url: '', attribution: '', min_interval_ms: 1000 } }),
      );
    const { container } = render(<PlaceSearch store={disabled} geocode={vi.fn<Geocode>()} />);
    expect(container).toBeEmptyDOMElement();

    const early = createSkyStore();
    const view2 = render(<PlaceSearch store={early} geocode={vi.fn<Geocode>()} />);
    expect(view2.container).toBeEmptyDOMElement();
  });
});
