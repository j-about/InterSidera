import { fireEvent, render, screen } from '@testing-library/react';
import { X } from 'lucide-react';

import IconButton from './IconButton';

describe('IconButton', () => {
  it('names the button with the label and hides the icon from assistive technology', () => {
    const onClick = vi.fn();
    render(<IconButton icon={X} label="Close" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-label', 'Close');
    expect(button).toHaveAttribute('title', 'Close');
    const icon = button.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('sizes the target: 36 px by default, 28 px small, 44 px on coarse pointers', () => {
    render(
      <>
        <IconButton icon={X} label="Default" />
        <IconButton icon={X} label="Small" size="sm" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Default' })).toHaveClass(
      'size-9',
      'pointer-coarse:size-11',
    );
    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass(
      'size-7',
      'pointer-coarse:size-11',
    );
  });

  it('passes disabled and aria state through', () => {
    render(<IconButton icon={X} label="Toggle" aria-pressed disabled />);
    const button = screen.getByRole('button', { name: 'Toggle' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});
