import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import PanelShell, { focusObscuredBySheet, matchesFocusVisible } from './PanelShell';

// Under jsdom `matchMedia` never matches (test setup), so this is the phone layout: the sheet
// handle and the strip render, the body follows `ui.sheet`. jsdom lays nothing out and never
// matches `:focus-visible`, so the focus-obscured tests stub the boxes and inject the focus test.

/** Pretend `element` occupies `box` (jsdom reports zero rects). */
function placeAt(element: Element, box: { top: number; bottom: number }): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 0, y: box.top, width: 320, height: box.bottom - box.top }),
  );
}

describe('PanelShell', () => {
  it('is the complementary landmark, focusable, with the four tabs bound to ui.panel', () => {
    const store = createSkyStore();
    render(<PanelShell store={store} />);
    const aside = screen.getByRole('complementary', { name: 'Controls' });
    expect(aside).toHaveAttribute('id', 'panel');
    expect(aside).toHaveAttribute('tabindex', '-1');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Observer', 'Time', 'Layers', 'Details']);
    expect(screen.getByRole('tab', { name: 'Observer' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Time' }));
    expect(store.getState().ui.panel).toBe('time');
    expect(store.getState().ui.sheet).toBe('expanded');
    expect(screen.getByRole('tabpanel', { name: 'Time' })).toHaveTextContent('Set date and time');

    act(() => {
      store.getState().actions.openPanel('layers');
    });
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('collapses and expands the sheet from the handle and Escape', () => {
    const store = createSkyStore();
    render(<PanelShell store={store} />);
    const handle = screen.getByRole('button', { name: 'Expand the control panel' });
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(handle).toHaveAttribute('aria-controls', 'panel-body');
    expect(document.getElementById('panel-body')).toHaveClass('hidden');

    fireEvent.click(handle);
    expect(store.getState().ui.sheet).toBe('expanded');
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    expect(handle).toHaveAccessibleName('Collapse the control panel');
    expect(document.getElementById('panel-body')).not.toHaveClass('hidden');
    // The whole sheet is capped at 70 dvh on the phone (WCAG 2.5.8, 2.4.11; plan D157 C7): the
    // top bar keeps the upper 30 % of the viewport; the desktop column is unbounded.
    expect(document.getElementById('panel')).toHaveClass('max-h-[70dvh]', 'md:max-h-none');
    expect(document.getElementById('panel')).not.toHaveClass('max-h-dvh');

    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(store.getState().ui.sheet).toBe('collapsed');
    expect(handle).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses the expanded sheet when a keyboard focus lands on a top-bar control it covers', () => {
    // The 320 px geometry measured at M6 (plan D157 C7): the top bar wraps to 300 px, the expanded
    // sheet starts at 74 px, the night switch (110-154 px) is entirely hidden, the search box is
    // not. A focus that is not `:focus-visible` (a tap) never collapses the sheet.
    const store = createSkyStore();
    store.getState().actions.setUi({ sheet: 'expanded' });
    const focusVisible = vi.fn<(element: Element) => boolean>(() => true);
    render(
      <>
        <header>
          <button type="button">Search</button>
          <button type="button">Night vision</button>
        </header>
        <PanelShell store={store} focusVisible={focusVisible} />
      </>,
    );
    const aside = screen.getByRole('complementary', { name: 'Controls' });
    const search = screen.getByRole('button', { name: 'Search' });
    const night = screen.getByRole('button', { name: 'Night vision' });
    placeAt(aside, { top: 74, bottom: 568 });
    placeAt(search, { top: 6, bottom: 50 });
    placeAt(night, { top: 110, bottom: 154 });

    fireEvent.focusIn(search);
    expect(store.getState().ui.sheet).toBe('expanded');

    focusVisible.mockReturnValue(false);
    fireEvent.focusIn(night);
    expect(store.getState().ui.sheet).toBe('expanded');

    focusVisible.mockReturnValue(true);
    fireEvent.focusIn(night);
    expect(store.getState().ui.sheet).toBe('collapsed');
    // Collapsed: the listener is gone until the sheet expands again.
    act(() => {
      store.getState().actions.setUi({ sheet: 'expanded' });
    });
    fireEvent.focusIn(screen.getByRole('tab', { name: 'Observer' }));
    expect(store.getState().ui.sheet).toBe('expanded');
  });

  it('decides the collapse from the header, the focus ring and the boxes', () => {
    const header = document.createElement('header');
    const control = document.createElement('button');
    header.appendChild(control);
    const outside = document.createElement('button');
    const sheet = document.createElement('aside');
    const inner = document.createElement('button');
    sheet.appendChild(inner);
    document.body.append(header, outside, sheet);
    placeAt(sheet, { top: 74, bottom: 568 });
    placeAt(control, { top: 110, bottom: 154 });
    placeAt(outside, { top: 110, bottom: 154 });
    placeAt(inner, { top: 110, bottom: 154 });
    const yes = (): boolean => true;
    expect(focusObscuredBySheet(control, sheet, yes)).toBe(true);
    expect(focusObscuredBySheet(control, sheet, () => false)).toBe(false);
    expect(focusObscuredBySheet(outside, sheet, yes)).toBe(false);
    expect(focusObscuredBySheet(inner, sheet, yes)).toBe(false);
    // Touching edges do not intersect; a zero-size box (an `sr-only` control) never does.
    placeAt(control, { top: 30, bottom: 74 });
    expect(focusObscuredBySheet(control, sheet, yes)).toBe(false);
    placeAt(control, { top: 30, bottom: 75 });
    expect(focusObscuredBySheet(control, sheet, yes)).toBe(true);
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect());
    expect(focusObscuredBySheet(control, sheet, yes)).toBe(false);
    // The default focus test is the browser's `:focus-visible`, which jsdom never matches.
    control.focus();
    expect(matchesFocusVisible(control)).toBe(false);
    expect(focusObscuredBySheet(control, sheet)).toBe(false);
    header.remove();
    outside.remove();
    sheet.remove();
  });

  it('drops the strip transport during a WebXR session, where the AR overlay owns it', () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    render(<PanelShell store={store} />);
    expect(screen.getByRole('group', { name: 'Speed' })).toBeInTheDocument();
    act(() => {
      actions.setArCapabilities({
        secure: true,
        camera: true,
        orientation: true,
        touch: true,
        videoInput: true,
      });
      actions.setArPermission('granted');
      actions.requestAr();
      actions.setArMode('sensor');
    });
    // The sensor mode keeps the strip's transport (the overlay has none there).
    expect(screen.getByRole('group', { name: 'Speed' })).toBeInTheDocument();
    act(() => {
      actions.setArMode('xr');
    });
    expect(screen.queryByRole('group', { name: 'Speed' })).toBeNull();
    expect(document.querySelectorAll('#transport-speed')).toHaveLength(0);
    act(() => {
      actions.exitAr();
    });
    expect(screen.getByRole('group', { name: 'Speed' })).toBeInTheDocument();
  });
});
