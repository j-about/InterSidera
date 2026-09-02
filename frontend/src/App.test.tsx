import { render, screen } from '@testing-library/react';

import App from './App';

describe('App', () => {
  it('renders the product name as the level-1 heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('InterSidera');
  });
});
