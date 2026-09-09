import { fireEvent, render, screen } from '@testing-library/react';

import Switch from './Switch';

describe('Switch', () => {
  it('is a switch named by its label with the state in aria and in text', () => {
    const onChange = vi.fn<(checked: boolean) => void>();
    const view = render(<Switch label="Night vision" checked={false} onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Night vision' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveTextContent('Off');

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);

    view.rerender(<Switch label="Night vision" checked onChange={onChange} />);
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveTextContent('On');
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
  });
});
