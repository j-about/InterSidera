import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import Dialog from './Dialog';

// The native `<dialog>` under the jsdom polyfill of `src/test/setup.ts` (backlog B-65):
// `showModal()` on open, focus inside then back to the opener on close, `onClose` on the close
// button and on a programmatic `close()`.

function Harness({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        title="About"
        onClose={() => {
          setOpen(false);
          onClosed?.();
        }}
      >
        <p>Body</p>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('calls showModal when opened and close when the prop turns off', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const onClose = vi.fn();
    const view = render(
      <Dialog open={false} title="About" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    expect(showModal).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    view.rerender(
      <Dialog open title="About" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    expect(showModal).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'About' });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading', { level: 2, name: 'About' })).toBeInTheDocument();

    view.rerender(
      <Dialog open={false} title="About" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    expect(dialog).not.toHaveAttribute('open');
    expect(onClose).toHaveBeenCalledTimes(1);
    showModal.mockRestore();
  });

  it('moves the focus inside on open and returns it to the opener on close', () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'About' });
    expect(dialog).toHaveAttribute('open');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveAttribute('open');
    expect(opener).toHaveFocus();
  });
});
