import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmationDialog from '../components/ConfirmationDialog.jsx';

/**
 * ADR 0009's seven properties, as executable assertions.
 *
 * These are not ordinary component tests. This dialog is the last place INV-A
 * can be undermined, so each property that can be expressed as a test is one --
 * otherwise "the confirm button must not be focused" is a sentence in a
 * document that a future refactor silently breaks.
 */

const proposal = {
  id: 'prop_1',
  actionType: 'order.cancel',
  target: { orderNumber: '1043' },
  confirmText: 'Cancel order 1043 — Wireless keyboard, £129.00, placed 2 days ago.',
};

function setup(overrides = {}) {
  const handlers = {
    onConfirm: vi.fn(),
    onReject: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(<ConfirmationDialog open proposal={proposal} {...handlers} {...overrides} />);
  return handlers;
}

describe('ConfirmationDialog — ADR 0009', () => {
  it('property 1: no button is labelled OK, Cancel, Yes or No', () => {
    setup();
    const forbidden = /^(ok|cancel|yes|no)$/i;
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent.trim()).not.toMatch(forbidden);
    }
  });

  it('property 1: both buttons name their outcome', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Cancel order 1043' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my order' })).toBeInTheDocument();
  });

  it('property 2: the confirm button is not focused on open', () => {
    setup();
    const confirm = screen.getByRole('button', { name: 'Cancel order 1043' });
    expect(confirm).not.toHaveFocus();
  });

  it('property 2: Enter immediately after open does not execute', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('property 3: the action text rendered is the stored proposal text', () => {
    setup();
    expect(screen.getByText(proposal.confirmText)).toBeInTheDocument();
  });

  it('property 4: Escape dismisses without deciding', async () => {
    const user = userEvent.setup();
    const { onDismiss, onReject, onConfirm } = setup();
    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('property 4: "Keep my order" is an explicit rejection, not a dismissal', async () => {
    const user = userEvent.setup();
    const { onReject, onDismiss } = setup();
    await user.click(screen.getByRole('button', { name: 'Keep my order' }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('confirming calls onConfirm exactly once', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel order 1043' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('property 6: the dialog is an alertdialog describing the action', () => {
    setup();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('property 6: Tab is trapped inside the dialog', async () => {
    const user = userEvent.setup();
    setup();
    const dialog = screen.getByRole('alertdialog');
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('fails closed: an action with no label mapping cannot be confirmed', () => {
    setup({ proposal: { ...proposal, actionType: 'order.refund' } });
    expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /can't be confirmed here/i }),
    ).toBeInTheDocument();
  });

  it('renders nothing when there is no proposal', () => {
    render(<ConfirmationDialog open proposal={null} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
