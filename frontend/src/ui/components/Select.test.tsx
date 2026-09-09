import { fireEvent, render, screen } from '@testing-library/react';

import Select from './Select';

type Unit = 'minute' | 'hour' | 'day';

const OPTIONS = [
  { value: 'minute', label: 'Minute' },
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day', disabled: true },
] as const satisfies readonly { value: Unit; label: string; disabled?: boolean }[];

describe('Select', () => {
  it('is a labelled native select reporting the typed value', () => {
    const onChange = vi.fn<(value: Unit) => void>();
    render(<Select id="unit" label="Step" value="hour" options={OPTIONS} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Step' });
    expect(select).toHaveValue('hour');
    expect(screen.getByRole('option', { name: 'Day' })).toBeDisabled();

    fireEvent.change(select, { target: { value: 'minute' } });
    expect(onChange).toHaveBeenCalledWith('minute');
  });

  it('hides the label visually on request and can be disabled with a description', () => {
    render(
      <>
        <p id="why">Fixed on this body.</p>
        <Select
          id="unit"
          label="Step"
          value="hour"
          options={OPTIONS}
          onChange={vi.fn()}
          hideLabel
          disabled
          describedBy="why"
        />
      </>,
    );
    const select = screen.getByRole('combobox', { name: 'Step' });
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription('Fixed on this body.');
    expect(screen.getByText('Step')).toHaveClass('sr-only');
  });
});
