import { fireEvent, render, screen } from '@testing-library/react';

import Banner from './Banner';

describe('Banner', () => {
  it('is a named status region with an icon, actions and a dismiss button', () => {
    const onDismiss = vi.fn();
    render(
      <Banner
        kind="status"
        title="Getting started"
        actions={<button type="button">Got it</button>}
        onDismiss={onDismiss}
      >
        Drag to look around.
      </Banner>,
    );
    const region = screen.getByRole('status', { name: 'Getting started' });
    expect(region).toHaveTextContent('Drag to look around.');
    expect(region.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders an alert with the danger tone and no dismiss button unless asked', () => {
    render(
      <Banner kind="alert" tone="danger">
        The sky service cannot be reached.
      </Banner>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The sky service cannot be reached.');
    expect(alert).toHaveClass('border-danger/60');
    expect(alert).not.toHaveAttribute('aria-labelledby');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses the warning icon for the warn tone', () => {
    render(
      <Banner kind="status" tone="warn">
        Elements extrapolated.
      </Banner>,
    );
    expect(screen.getByRole('status')).toHaveClass('border-warn/60');
    expect(screen.getByRole('status').querySelector('svg')).toHaveClass('text-warn');
  });
});
