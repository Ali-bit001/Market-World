'use client';

import React, { Suspense } from 'react';
import NavigationOverlay from './NavigationOverlay';

// useSearchParams requires a Suspense boundary in Next.js App Router
const NavigationProgress = () => (
    <Suspense fallback={null}>
        <NavigationOverlay />
    </Suspense>
);

export default NavigationProgress;
