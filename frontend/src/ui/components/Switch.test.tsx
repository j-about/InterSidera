import { fireEvent, render, screen } from '@testing-library/react';

import Switch from './Switch';

describe('Switch', () => {
  it('is a switch named by its label with the state in aria and in text', () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    const view = render(<Switch label="Night vision" checked={false} onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Night vision' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    // The state word is visible beside the control, outside it and hidden from assistive
    // technology: the control's visible text is its name and nothing more (WCAG 2.5.3, plan D157
    // C4; axe `label-content-name-mismatch` counts `aria-hidden` text as visible).
    expect(control).toHaveAccessibleName('Night vision');
    expect(control).toHaveTextContent(/^Night vision$/);
    const state = screen.getByText('Off');
    expect(state).toHaveAttribute('aria-hidden', 'true');
    expect(control.contains(state)).toBe(false);
    expect(control.parentElement).toBe(state.parentElement);

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);

    view.rerender(<Switch label="Night vision" checked onChange={onChange} />);
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('On')).toHaveAttribute('aria-hidden', 'true');
    expect(control).not.toHaveTextContent('On');
    fireEvent.click(control);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('can be disabled with a reason', () => {
    render(
      <>
        <p id="why">No minor-body data on this server.</p>
        <Switch
          label="Minor bodies"
          checked={false}
          onChange={vi.fn()}
          disabled
          describedBy="why"
        />
      </>,
    );
    const control = screen.getByRole('switch', { name: 'Minor bodies' });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription('No minor-body data on this server.');
    expect(screen.getByText('Off')).toHaveClass('opacity-50');
  });
});
