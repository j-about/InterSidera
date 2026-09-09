import { fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { speedList } from '../../state/timeDisplay';
import SpeedSelect, { speedLabel } from './SpeedSelect';

// The speed select: unit labels with plurals and the backward suffix, the paused entry, a value
// outside the list, and the numeric change.

describe('SpeedSelect', () => {
  it('labels the signed list by unit and inserts "Paused" for 0', () => {
    const onChange = vi.fn<(speed: number) => void>();
    render(<SpeedSelect id="s" speeds={speedList([1, 60, 86400])} value={0} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Speed' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '1 day/s, backward',
      '1 min/s, backward',
      '1 s/s, backward',
      'Paused',
      '1 s/s',
      '1 min/s',
      '1 day/s',
    ]);
    expect(select).toHaveValue('0');
    fireEvent.change(select, { target: { value: '86400' } });
    expect(onChange).toHaveBeenCalledWith(86400);
  });

  it('adds a value outside the list in order and pluralises', () => {
    render(<SpeedSelect id="s" speeds={speedList([1, 60])} value={172800} onChange={vi.fn()} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '1 min/s, backward',
      '1 s/s, backward',
      '1 s/s',
      '1 min/s',
      '2 days/s',
    ]);
    expect(screen.getByRole('combobox')).toHaveValue('172800');
  });

  it('formats labels through speedLabel', () => {
    const t = i18next.t.bind(i18next);
    expect(speedLabel(t, 0)).toBe('Paused');
    expect(speedLabel(t, 600)).toBe('10 min/s');
    expect(speedLabel(t, -31557600)).toBe('1 year/s, backward');
    expect(speedLabel(t, 63115200)).toBe('2 years/s');
  });
});
