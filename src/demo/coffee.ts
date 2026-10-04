/**
 * Demo mode “Case from the article” — article §5 (Before You Choose v11)
 * Illustrative dialogue only; not a real experiment log.
 * Currency: USD. No regional localization.
 */

export const COFFEE_DEMO = {
  title: 'Case: coffee shop (from the article)',
  steps: {
    brief: {
      decision: 'Quit my job and open a coffee shop in my neighborhood',
      deadline: '',
      goal: 'Autonomy without losing the mortgage',
      facts: [
        'Savings cover roughly 5 months of living expenses without income',
        'Have a mortgage',
        'Work as an analyst',
        'No food-service experience',
      ],
      unknowns: [
        'Rent rate and share of revenue',
        'Opening cost from a real estimate',
        'Mortgage forbearance / hardship terms',
        'Paying demand outside close circle',
      ],
      assumptions: [
        'There is demand in the neighborhood',
        'I can handle the operational load',
        'Opening will consume roughly three of the five months of savings',
      ],
      values: ['Autonomy', 'Not losing the mortgage'],
      constraints: ['Savings: ~5 months', 'Mortgage payments continue'],
      myOptions: [
        { id: 'opt_user_0', title: 'Quit and open the shop' },
        { id: 'opt_user_1', title: 'Stay in the current job' },
      ],
      leaningOptionId: 'NONE',
      errorCost: { preliminary: 'HIGH' as const },
      reversibility: { preliminary: 'ONE_WAY' as const },
      reviewDates: [],
    },
  },
  notes:
    'From your data: five months of savings, opening roughly three months, no food-service experience, mortgage terms unchecked. Critical unknowns — rent, demand outside the circle, and bank forbearance.',
};
