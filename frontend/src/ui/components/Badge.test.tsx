import { render, screen } from '@testing-library/react';
import { TriangleAlert } from 'lucide-react';

import Badge from './Badge';

describe('Badge', () => {
  it('shows an icon and a text, the icon hidden from assistive technology', () => {
    render(
      <Badge icon={TriangleAlert} tone="warn" title="Valid 1550 to 2650">
        Approximate
      </Badge>,
    );
    const badge = screen.getByText('Approximate');
    expect(badge).toHaveAttribute('title', 'Valid 1550 to 2650');
    expect(badge).toHaveClass('text-warn');
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('is muted by default', () => {
    render(<Badge icon={TriangleAlert}>Snapshot</Badge>);
    expect(screen.getByText('Snapshot')).toHaveClass('text-muted');
  });
});
