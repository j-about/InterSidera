import { fireEvent, render, screen } from '@testing-library/react';

import Sheet from './Sheet';

function renderSheet(
  expanded: boolean,
  onToggle = vi.fn<(expanded: boolean) => void>(),
  escapeCollapses?: boolean,
) {
  const view = render(
    <Sheet
      id="body"
      expanded={expanded}
      onToggle={onToggle}
      expandLabel="Expand"
      collapseLabel="Collapse"
      strip={<span>strip</span>}
      {...(escapeCollapses === undefined ? {} : { escapeCollapses })}
    >
      <p>content</p>
      <input aria-label="field" />
    </Sheet>,
  );
  return { view, onToggle };
}

describe('Sheet', () => {
  it('exposes the handle with aria-expanded and aria-controls and hides the body when collapsed', () => {
    const { onToggle } = renderSheet(false);
    const handle = screen.getByRole('button', { name: 'Expand' });
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(handle).toHaveAttribute('aria-controls', 'body');
    const body = document.getElementById('body');
    expect(body).toHaveClass('hidden', 'md:block');
    // The parent caps the whole sheet; the body is the part that shrinks and scrolls (plan D157 C7).
    expect(body).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain', 'touch-pan-y');
    expect(body).not.toHaveClass('max-h-[70dvh]');
    expect(handle).toHaveClass('shrink-0');
    const strip = screen.getByText('strip').parentElement;
    // The collapsed strip wraps (WCAG 1.4.10 at 320 px, plan D157 C7): never a sideways scroller,
    // and never squeezed by the cap.
    expect(strip).toHaveClass('flex-wrap', 'min-h-strip', 'shrink-0', 'md:hidden');
    expect(strip).not.toHaveClass('overflow-x-auto', 'h-strip');

    fireEvent.click(handle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows the body when expanded and collapses on Escape, except inside a dialog', () => {
    const { onToggle } = renderSheet(true);
    const handle = screen.getByRole('button', { name: 'Collapse' });
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById('body');
    expect(body).toHaveClass('block');
    expect(body).not.toHaveClass('hidden');

    fireEvent.click(handle);
    expect(onToggle).toHaveBeenCalledWith(false);
    onToggle.mockClear();

    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(onToggle).toHaveBeenCalledWith(false);
    onToggle.mockClear();

    // A key already handled elsewhere, or pressed inside a modal dialog, is left alone.
    fireEvent.keyDown(window, { key: 'Enter' });
    const dialog = document.createElement('dialog');
    document.body.appendChild(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onToggle).not.toHaveBeenCalled();
    dialog.remove();
  });

  it('leaves Escape to an editable control and to the desktop layout', () => {
    const { onToggle, view } = renderSheet(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'field' }), { key: 'Escape' });
    expect(onToggle).not.toHaveBeenCalled();
    view.unmount();

    const desktop = renderSheet(true, undefined, false);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Collapse' }), { key: 'Escape' });
    expect(desktop.onToggle).not.toHaveBeenCalled();
  });

  it('stops listening once collapsed', () => {
    const onToggle = vi.fn<(expanded: boolean) => void>();
    const { view } = renderSheet(true, onToggle);
    view.rerender(
      <Sheet
        id="body"
        expanded={false}
        onToggle={onToggle}
        expandLabel="Expand"
        collapseLabel="Collapse"
      >
        <p>content</p>
      </Sheet>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onToggle).not.toHaveBeenCalled();
  });
});
