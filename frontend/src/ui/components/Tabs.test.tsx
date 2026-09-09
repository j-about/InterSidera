import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import Tabs from './Tabs';

type Id = 'a' | 'b' | 'c';

const ITEMS = [
  { id: 'a', label: 'Alpha', panel: <p>Panel A</p> },
  { id: 'b', label: 'Beta', panel: <p>Panel B</p> },
  { id: 'c', label: 'Gamma', panel: <p>Panel C</p> },
] as const satisfies readonly { id: Id; label: string; panel: React.ReactNode }[];

function Harness({ onSelect }: { onSelect?: (id: Id) => void }) {
  const [selected, setSelected] = useState<Id>('a');
  return (
    <Tabs
      idBase="t"
      label="Sections"
      items={ITEMS}
      selected={selected}
      onSelect={(id) => {
        setSelected(id);
        onSelect?.(id);
      }}
    />
  );
}

describe('Tabs', () => {
  it('renders the tablist pattern with a roving tabindex and linked panels', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[0]).toHaveAttribute('aria-controls', 't-panel-a');
    const panel = screen.getByRole('tabpanel', { name: 'Alpha' });
    expect(panel).toHaveAttribute('id', 't-panel-a');
    expect(panel).toHaveAttribute('tabindex', '0');
    expect(panel).toHaveTextContent('Panel A');
    // The other panels stay mounted but hidden.
    expect(document.getElementById('t-panel-b')).toHaveAttribute('hidden');
  });

  it('selects on click', () => {
    const onSelect = vi.fn<(id: Id) => void>();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Beta' })).toBeVisible();
  });

  it('moves selection and focus with the arrow keys, Home and End, wrapping around', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    const beta = screen.getByRole('tab', { name: 'Beta' });
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(beta).toHaveFocus();

    fireEvent.keyDown(beta, { key: 'End' });
    const gamma = screen.getByRole('tab', { name: 'Gamma' });
    expect(gamma).toHaveAttribute('aria-selected', 'true');
    expect(gamma).toHaveFocus();

    fireEvent.keyDown(gamma, { key: 'ArrowDown' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(alpha).toHaveFocus();

    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(gamma).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');

    // Other keys are left alone.
    fireEvent.keyDown(alpha, { key: 'Enter' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
  });
});
