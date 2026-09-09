
# WorksideQA Phase 7 – Codex Implementation Plan

## Executive Summary
The foundation is complete. Freeze the architecture and focus on platform maturity.

## Review
Based on the current status, WorksideQA has achieved a strong v0.1.0-alpha foundation with modular architecture, release orchestration, dashboarding, AI-assisted reporting, workflow assertions for RadiusIQ and Merxus, and a one-command release process.

## Phase 7 Objectives

### Priority 1
- Implement `npm run qa:env:health`
- Add manifest dependency graph (web/API/Firebase/OpenAI)
- Validate prerequisites before tests begin.
- Expand workflow assertions:
  - SageSet
  - Route Logistics
  - Support Console
  - AnyRyde

### Priority 2
- Dashboard V3
  - Product timelines
  - Category scorecards
  - Failure explanations
  - Startup trends
  - Release comparison

- Intelligent Release Advisor
  - Deploy / Hold / Investigate recommendation
  - Risk scoring
  - Regression analysis

### Priority 3
- Git Safety Gate
- Secret scanning
- Artifact validation
- CI profile
- Executive engineering email

## Codex Rules
- Preserve package architecture.
- Keep qa-core product agnostic.
- Product workflows remain inside product folders.
- Never expose secrets.
- Never commit generated reports.
- Update README and Roadmap after completion.

## Acceptance Criteria
- qa:release remains the primary workflow.
- qa:env:health validates local prerequisites.
- Four remaining products gain workflow coverage.
- Dashboard reflects workflow maturity.
- AI Release Advisor recommends Deploy/Hold/Investigate.
- No regressions in existing RadiusIQ or Merxus workflows.
