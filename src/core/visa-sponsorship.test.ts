import { describe, expect, test } from 'bun:test';
import { explicitNoSponsorship } from './visa-sponsorship';

describe('explicitNoSponsorship — refusals', () => {
  test.each([
    'We are unable to sponsor visas for this role.',
    "We're unable to sponsor work visas at this time.",
    'We will not sponsor employment visas.',
    'The company will not be able to sponsor candidates.',
    'We do not offer visa sponsorship.',
    "We don't provide any visa sponsorship for this position.",
    'We cannot sponsor H-1B visas.',
    'Company does not sponsor.',
    'No visa sponsorship available for this role.',
    'Please note: no sponsorship.',
    'Visa sponsorship is not available.',
    'Sponsorship will not be provided.',
    'This role is not eligible for visa sponsorship.',
    'Must be legally authorized to work in the United States without sponsorship.',
    'Applicants must be authorized to work in the US without the need for current or future visa sponsorship.',
    'You must not require sponsorship now or in the future.',
    'Candidates who require visa sponsorship will not be considered.',
    'We are unable to consider candidates who require sponsorship.',
    'We do not offer relocation or visa sponsorship.',
    'Sorry, we are unable to sponsor at this time.',
    'We are unable to sponsor for this role, but the team is great.',
    'Qualifications:\n- Python\n- Unable to sponsor visas',
  ])('drops: %s', (jd) => {
    expect(explicitNoSponsorship(jd)).not.toBeNull();
  });

  test('returns the matched phrase for the reason text', () => {
    expect(explicitNoSponsorship('Great team. We are unable to sponsor visas. Apply now.')).toBe('unable to sponsor');
  });
});

describe('explicitNoSponsorship — passes', () => {
  test.each([
    'We can sponsor visas for the right candidate.',
    'Visa sponsorship is available.',
    'Visa sponsorship available for exceptional candidates.',
    'We sponsor H-1B visas and offer relocation.',
    'We will sponsor your work permit.',
    'We do not require relocation, and we can sponsor visas.',
    'We do not offer relocation but do sponsor visas.',
    'No sponsorship is required from you.',
    'Sponsorship is not a problem for us.',
    'We do not hesitate to hire from abroad. Sponsorship may be available.',
    'Sponsorship is available. We are unable to sponsor contractors.',
    'We cannot sponsor contractors, but we can sponsor full-time employees.',
    'Our sponsorship of open source projects is a point of pride.',
    'Authorized to work anywhere in the EU? Great.',
    'You may work remotely without supervision.',
    'Candidates who need visa sponsorship are welcome to apply.',
    'We are unable to sponsor relocation costs.',
    'The company does not sponsor any events.',
    'We are not able to offer sponsorship for conference attendance.',
    'Sponsorship is not available for training budgets.',
    '',
  ])('keeps: %s', (jd) => {
    expect(explicitNoSponsorship(jd)).toBeNull();
  });

  test('null or undefined JD passes', () => {
    expect(explicitNoSponsorship(undefined)).toBeNull();
    expect(explicitNoSponsorship(null)).toBeNull();
  });
});
