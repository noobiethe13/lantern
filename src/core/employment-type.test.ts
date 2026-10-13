import { describe, expect, test } from 'bun:test';
import { employmentTypesInTitle, normalizeEmploymentLabel } from './employment-type';

// Titles go through filter.ts's normalizeForMatch first, which lowercases and turns
// "-" and "/" into spaces. Mirror that here.
const norm = (t: string) => t.toLowerCase().replace(/[-_/]+/g, ' ');
const types = (t: string): string[] => [...employmentTypesInTitle(norm(t))].sort();

describe('employmentTypesInTitle', () => {
  test.each([
    ['Software Engineering Intern', ['internship']],
    ['Summer 2026 Internship - Data Science', ['internship']],
    ['Backend Engineer (Contract)', ['contract']],
    ['Contract Backend Engineer', ['contract']],
    ['DevOps Contractor', ['contract']],
    ['Freelance Designer', ['contract']],
    ['Part-Time Support Engineer', ['part_time']],
    ['Engineer - Full-time', ['full_time']],
    ['Temporary Warehouse Lead', ['temporary']],
    ['Engineer (Contract / Part-time)', ['contract', 'part_time']],
    ['Engineer (Full-time, part-time OK)', ['full_time']],
  ])('%s -> %p', (title, expected) => {
    expect(types(title)).toEqual(expected);
  });

  test.each([
    'International Sales Manager',
    'Internal Tools Engineer',
    'Head of Internal Communications',
    'Contract Manager',
    'Contracts Administrator',
    'Contract Specialist',
    'Senior Backend Engineer',
    'Temp Agency Liaison',
    'Intern Program Manager',
    'Internship Coordinator',
    'Intern Recruiter',
    'University Recruiter (Interns)',
    'Temporary Housing Coordinator',
    'Temporary Worker Platform PM',
    'Contractor Payments Engineer',
    'Contractor Management Lead',
    'Contractors Success Lead',
    'Backend Engineer (Part-time OK)',
    'Engineer - Contract possible',
    'Engineer, open to part-time',
  ])('%s states no type', (title) => {
    expect(types(title)).toEqual([]);
  });
});

describe('normalizeEmploymentLabel', () => {
  test.each([
    ['Full-time', 'full_time'],
    ['FullTime', 'full_time'],
    ['Part Time', 'part_time'],
    ['Intern', 'internship'],
    ['Contract', 'contract'],
    ['Temporary', 'temporary'],
  ])('%s -> %s', (label, expected) => {
    expect(normalizeEmploymentLabel(label) as string).toBe(expected);
  });

  test('unknown or non-string labels are undefined', () => {
    expect(normalizeEmploymentLabel('Permanent')).toBeUndefined();
    expect(normalizeEmploymentLabel(undefined)).toBeUndefined();
    expect(normalizeEmploymentLabel(3)).toBeUndefined();
  });
});
