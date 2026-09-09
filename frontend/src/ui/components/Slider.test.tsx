import { fireEvent, render, screen } from '@testing-library/react';

import Slider from './Slider';

describe('Slider', () => {
  it('is a labelled range input with a bound output and a spoken value', () => {
    const onChange = vi.fn<(value: number) => void>();
    render(
      <Slider
        id="brightness"
        label="Brightness"
        value={0.6}
        min={0.3}
        max={1}
        step={0.01}
        onChange={onChange}
        format={(value) => `${String(Math.round(value * 100))} %`}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Brightness' });
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '0.3');
    expect(slider).toHaveAttribute('max', '1');
    expect(slider).toHaveAttribute('step', '0.01');
    expect(slider).toHaveValue('0.6');
    expect(slider).toHaveAttribute('aria-valuetext', '60 %');
    const output = document.querySelector('output');
    expect(output).toHaveAttribute('for', 'brightness');
    expect(output).toHaveTextContent('60 %');

    fireEvent.change(slider, { target: { value: '0.45' } });
    expect(onChange).toHaveBeenCalledWith(0.45);
  });

  it('formats the plain number by default and honours disabled', () => {
    render(
      <Slider
        id="mag"
        label="Magnitude"
        value={5.5}
        min={0}
        max={12}
        step={0.1}
        onChange={vi.fn()}
        disabled
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Magnitude' });
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute('aria-valuetext', '5.5');
  });
});
