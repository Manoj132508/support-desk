import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PolicyBlock from '../components/PolicyBlock.jsx';
import { ERROR_KIND, isPolicyKind } from '../lib/outcomes.js';

/**
 * Phase 4 section 5: three of the four error kinds are not errors.
 *
 * The assertions below are the guard on that. If a future change makes a
 * refusal render with `role="alert"` and the fault styling, these fail -- which
 * is the point, because that change would quietly erase the project's central
 * demonstration into an error state.
 */
describe('PolicyBlock', () => {
  it('treats refused, stale and malformed as policy, and fault as not', () => {
    expect(isPolicyKind(ERROR_KIND.REFUSED)).toBe(true);
    expect(isPolicyKind(ERROR_KIND.STALE)).toBe(true);
    expect(isPolicyKind(ERROR_KIND.MALFORMED)).toBe(true);
    expect(isPolicyKind(ERROR_KIND.FAULT)).toBe(false);
  });

  it.each([ERROR_KIND.REFUSED, ERROR_KIND.STALE, ERROR_KIND.MALFORMED])(
    'renders %s as a note, not an alert',
    (kind) => {
      render(<PolicyBlock kind={kind} customerMessage="Not possible after dispatch." />);
      expect(screen.getByRole('note')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('renders a fault as an alert', () => {
    render(<PolicyBlock kind={ERROR_KIND.FAULT} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('an unknown kind renders as a fault, never as a decision nobody made', () => {
    render(<PolicyBlock kind="approved" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('shows the rule-authored customer message', () => {
    render(
      <PolicyBlock kind={ERROR_KIND.REFUSED} customerMessage="Not possible after dispatch." />,
    );
    expect(screen.getByText('Not possible after dispatch.')).toBeInTheDocument();
  });

  it('ADR 0007: hides internal detail unless explicitly asked for', () => {
    const detail = { ruleKey: 'POL-CANCEL-DISPATCHED', ruleVersion: 2, internalReason: 'Carrier interception.' };
    render(
      <PolicyBlock
        kind={ERROR_KIND.REFUSED}
        customerMessage="Not possible after dispatch."
        detail={detail}
      />,
    );
    expect(screen.queryByText(/POL-CANCEL-DISPATCHED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Carrier interception/)).not.toBeInTheDocument();
  });

  it('ADR 0007: shows internal detail, including the rule’s internal reason, on internal surfaces', () => {
    const detail = { ruleKey: 'POL-CANCEL-DISPATCHED', ruleVersion: 2, internalReason: 'Carrier interception.' };
    render(
      <PolicyBlock
        kind={ERROR_KIND.REFUSED}
        customerMessage="Not possible after dispatch."
        detail={detail}
        showDetail
      />,
    );
    expect(screen.getByText(/POL-CANCEL-DISPATCHED · v2/)).toBeInTheDocument();
    expect(screen.getByText('Carrier interception.')).toBeInTheDocument();
  });

  it('ADR 0007: a missing customer message falls back to generic copy, never to the rule detail', () => {
    const detail = { ruleKey: 'POL-CANCEL-DISPATCHED', ruleVersion: 2 };
    render(<PolicyBlock kind={ERROR_KIND.REFUSED} detail={detail} escalated />);
    expect(screen.getByText(/bring in a colleague/i)).toBeInTheDocument();
    expect(screen.queryByText(/POL-CANCEL-DISPATCHED/)).not.toBeInTheDocument();
  });

  it.each([ERROR_KIND.REFUSED, ERROR_KIND.STALE, ERROR_KIND.MALFORMED, ERROR_KIND.FAULT])(
    'ADR 0010: a %s block that did not escalate promises no colleague, in its heading or its fallback',
    (kind) => {
      const { container } = render(<PolicyBlock kind={kind} />);
      expect(container.textContent).not.toMatch(/colleague|person/i);
    },
  );

  it('ADR 0010: an escalated block says a colleague is coming, and offers no button to ask again', () => {
    render(
      <PolicyBlock
        kind={ERROR_KIND.REFUSED}
        customerMessage="This order has already been dispatched."
        escalated
        onEscalate={vi.fn()}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('A colleague will pick this up');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a next step so a refusal cannot dead-end', () => {
    render(
      <PolicyBlock
        kind={ERROR_KIND.REFUSED}
        customerMessage="Not possible after dispatch."
        onEscalate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /talk to a person/i })).toBeInTheDocument();
  });

  it('shows that a request for a person is on its way', () => {
    render(<PolicyBlock kind={ERROR_KIND.REFUSED} customerMessage="No." onEscalate={vi.fn()} escalating />);
    expect(screen.getByRole('button', { name: /talk to a person/i })).toBeDisabled();
  });

  it('offers retry on a fault, not escalation', () => {
    render(<PolicyBlock kind={ERROR_KIND.FAULT} onRetry={vi.fn()} onEscalate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /talk to a person/i })).not.toBeInTheDocument();
  });

  it('a fault that escalated says a colleague has it, and offers no retry that could not work', () => {
    render(<PolicyBlock kind={ERROR_KIND.FAULT} onRetry={vi.fn()} escalated />);
    expect(screen.getByRole('alert')).toHaveTextContent(/passed this to a colleague/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
