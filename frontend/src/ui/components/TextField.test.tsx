import { fireEvent, render, screen } from '@testing-library/react';

import TextField from './TextField';

describe('TextField', () => {
  it('is a labelled input whose hint is its description', () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(
      <TextField
        id="lat"
        label="Latitude"
        hint="Decimal degrees or DMS"
        value="51.48"
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Latitude' });
    expect(input).toHaveValue('51.48');
    expect(input).toHaveAccessibleDescription('Decimal degrees or DMS');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(input, { target: { value: '48.86' } });
    expect(onValueChange).toHaveBeenCalledWith('48.86');
  });

  it('announces an error and marks the field invalid', () => {
    render(
      <TextField
        id="lat"
        label="Latitude"
        hint="Decimal degrees"
        error="Out of range"
        value="99"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Latitude' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Decimal degrees Out of range');
    expect(screen.getByRole('alert')).toHaveTextContent('Out of range');
    expect(input).toHaveClass('border-danger');
  });

  it('treats null and empty errors as valid and can hide its label', () => {
    render(<TextField id="q" label="Search" error={null} hideLabel />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(screen.getByText('Search')).toHaveClass('sr-only');
  });
});
