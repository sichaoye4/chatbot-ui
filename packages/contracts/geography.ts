// Versioned, bundled demonstration geography; never presented as real-world boundaries.
export const geographyAssets: Record<string, { label: string; regions: Record<string, string> }> = {
  'synthetic-districts-v1': {
    label: 'Synthetic districts (not real geography)',
    regions: {
      NW: 'M100,50 L300,50 L300,190 L100,190 Z',
      NE: 'M300,50 L500,50 L500,190 L300,190 Z',
      SW: 'M100,190 L300,190 L300,330 L100,330 Z',
      SE: 'M300,190 L500,190 L500,330 L300,330 Z',
    },
  },
};
