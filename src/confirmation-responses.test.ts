/**
 * Confirmation Flow Response Builders Tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildSafeModeBlockedResponse,
  buildInvalidParameterResponse,
  buildConflictingParametersResponse,
  buildConfirmationRequiredResponse,
  buildPreviewRequiredResponse,
  buildPreviewExpiredResponse,
  buildNoChangeResponse,
  type ConfirmationContext,
} from './confirmation-responses.js';

const ctx: ConfirmationContext = {
  tool: 'delete_site_v1',
  ability: 'mainwp/delete-site-v1',
};

describe('buildSafeModeBlockedResponse', () => {
  it('should include error code and message', () => {
    const response = buildSafeModeBlockedResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('SAFE_MODE_BLOCKED');
    expect(response.message).toContain('Safe mode blocked');
    expect(response.message).toContain('delete_site_v1');
  });

  it('should include tool and ability context', () => {
    const response = buildSafeModeBlockedResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.tool).toBe('delete_site_v1');
    expect(response.details.ability).toBe('mainwp/delete-site-v1');
  });

  it('should provide resolution guidance', () => {
    const response = buildSafeModeBlockedResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.reason).toContain('safe mode');
    expect(response.details.resolution).toContain('MAINWP_SAFE_MODE');
  });

  it('should not include next_action (terminal error)', () => {
    const response = buildSafeModeBlockedResponse(ctx) as Record<string, unknown>;

    expect(response.next_action).toBeUndefined();
  });
});

describe('buildInvalidParameterResponse', () => {
  it('should indicate invalid parameter error', () => {
    const response = buildInvalidParameterResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('INVALID_PARAMETER');
    expect(response.message).toContain('user_confirmed');
  });

  it('should include context details', () => {
    const response = buildInvalidParameterResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.tool).toBe('delete_site_v1');
    expect(response.details.ability).toBe('mainwp/delete-site-v1');
  });

  it('should explain the resolution', () => {
    const response = buildInvalidParameterResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.resolution).toContain('Remove');
    expect(response.details.resolution).toContain('user_confirmed');
  });

  it('should not include next_action (terminal error)', () => {
    const response = buildInvalidParameterResponse(ctx) as Record<string, unknown>;

    expect(response.next_action).toBeUndefined();
  });
});

describe('buildConflictingParametersResponse', () => {
  it('should indicate conflicting parameters error', () => {
    const response = buildConflictingParametersResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('CONFLICTING_PARAMETERS');
    expect(response.message).toContain('user_confirmed');
    expect(response.message).toContain('dry_run');
  });

  it('should explain the conflict', () => {
    const response = buildConflictingParametersResponse(ctx) as {
      details: Record<string, unknown>;
    };

    expect(response.details.reason).toContain('dry_run');
    expect(response.details.reason).toContain('user_confirmed');
  });

  it('should not include next_action (terminal error)', () => {
    const response = buildConflictingParametersResponse(ctx) as Record<string, unknown>;

    expect(response.next_action).toBeUndefined();
  });
});

describe('buildConfirmationRequiredResponse', () => {
  const preview = { affected_sites: [1, 2, 3], total: 3 };

  it('should include status and preview data', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview, 'test-token-uuid') as Record<
      string,
      unknown
    >;

    expect(response.status).toBe('CONFIRMATION_REQUIRED');
    expect(response.next_action).toBe('show_preview_and_confirm');
    expect(response.preview).toEqual(preview);
  });

  it('should include instructions for confirmation', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview, 'test-token-uuid') as Record<
      string,
      unknown
    >;

    expect(response.instructions).toContain('user_confirmed');
    expect(response.instructions).toContain('confirmation_token');
  });

  it('should include confirmation_token at top level', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview, 'test-token-uuid') as Record<
      string,
      unknown
    >;

    expect(response.confirmation_token).toBe('test-token-uuid');
  });

  it('should include metadata with expiry', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview, 'test-token-uuid') as {
      metadata: Record<string, unknown>;
    };

    expect(response.metadata.tool).toBe('delete_site_v1');
    expect(response.metadata.ability).toBe('mainwp/delete-site-v1');
    expect(response.metadata.expiresIn).toContain('5 minutes');
    // confirmation_token is at top level, not in metadata
    expect(response.metadata.confirmation_token).toBeUndefined();
  });
});

describe('buildPreviewRequiredResponse', () => {
  it('should indicate preview required error', () => {
    const response = buildPreviewRequiredResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('PREVIEW_REQUIRED');
    expect(response.next_action).toBe('request_preview_first');
    expect(response.message).toContain('No preview found');
  });

  it('should explain how to generate preview', () => {
    const response = buildPreviewRequiredResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.resolution).toContain('confirm: true');
  });
});

describe('buildPreviewExpiredResponse', () => {
  it('should indicate preview expired error', () => {
    const response = buildPreviewExpiredResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('PREVIEW_EXPIRED');
    expect(response.next_action).toBe('request_new_preview');
    expect(response.message).toContain('expired');
  });

  it('should include expiry reason', () => {
    const response = buildPreviewExpiredResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.reason).toContain('5 minutes');
  });

  it('should explain how to generate new preview', () => {
    const response = buildPreviewExpiredResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.resolution).toContain('confirm: true');
  });
});

describe('buildNoChangeResponse', () => {
  it('should include NO_CHANGE status and message', () => {
    const response = buildNoChangeResponse(
      ctx,
      'already_active',
      'Already active — no action needed'
    ) as Record<string, unknown>;

    expect(response.status).toBe('NO_CHANGE');
    expect(response.message).toContain('no effect');
    expect(response.message).toContain('delete_site_v1');
  });

  it('should include tool, ability, code, and reason in details', () => {
    const response = buildNoChangeResponse(
      ctx,
      'already_active',
      'Already active — no action needed'
    ) as {
      details: Record<string, unknown>;
    };

    expect(response.details.tool).toBe('delete_site_v1');
    expect(response.details.ability).toBe('mainwp/delete-site-v1');
    expect(response.details.code).toBe('already_active');
    expect(response.details.reason).toContain('Already active');
  });

  it('should not include error or next_action fields', () => {
    const response = buildNoChangeResponse(
      ctx,
      'already_active',
      'Already active — no action needed'
    ) as Record<string, unknown>;

    expect(response.error).toBeUndefined();
    expect(response.next_action).toBeUndefined();
  });
});
