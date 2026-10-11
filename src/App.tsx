import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';

import { queryClient } from '@/api/query';
import { createAppRouter } from './routes';

const router = createAppRouter();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
