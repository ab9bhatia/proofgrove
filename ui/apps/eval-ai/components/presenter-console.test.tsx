import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PresenterConsole } from './presenter-console';
const links = { baseline: '/runs/example', comparison: '/evaluations/example/compare' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('presenter console', () => {
  it('keeps note changes private until the presenter explicitly sends a stop', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PresenterConsole links={links} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next notes →' }));
    expect(screen.getByRole('heading', { name: 'An expectation becomes a test' })).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show this stop to the audience ↗' }));
    expect(open).toHaveBeenCalledWith('/learn#what', 'proofgrove-audience');
    expect(screen.getByRole('alert').textContent).toContain('blocked');
  });
  it('reuses the audience window and sends a saved fallback', () => {
    const audience = { closed: false, location: { href: '' }, focus: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(audience as unknown as Window);
    render(<PresenterConsole links={links} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show saved fallback' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(audience.location.href).toBe(links.baseline);
  });
  it('starts, pauses and resets the elapsed clock', () => {
    vi.useFakeTimers();
    render(<PresenterConsole links={links} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByLabelText('Elapsed session time').textContent).toBe('00:03');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByLabelText('Elapsed session time').textContent).toBe('00:03');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Elapsed session time').textContent).toBe('00:00');
  });
});
