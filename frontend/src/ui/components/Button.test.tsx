import { fireEvent, render, screen } from '@testing-library/react';

import Button from './Button';

describe('Button', () => {
  it('is a plain button by default, with the minimum target classes', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('min-h-6', 'min-w-6', 'pointer-coarse:min-h-11');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('passes aria state, the submit type, variants and extra classes through', () => {
    render(
      <Button type="submit" variant="primary" aria-pressed className="extra">
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass('bg-accent', 'extra');
  });

  it('renders disabled', () => {
    render(<Button disabled>Off</Button>);
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled();
  });
});
