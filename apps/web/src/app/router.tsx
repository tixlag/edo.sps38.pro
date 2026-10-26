import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { DashboardPage } from '../pages/DashboardPage';
import { EmployeesPage } from '../pages/EmployeesPage';
import { EmployeeDetailPage } from '../pages/EmployeeDetailPage';
import { ReviewPage, ReviewDocumentPage } from '../pages/ReviewPage';
import { CandidatesPage } from '../pages/CandidatesPage';
import { CandidateWorkspacePage } from '../pages/CandidateWorkspacePage';
import { HistoryPage, MyReviews } from '../pages/HistoryPage';
import { useEmployeeRouteId } from './AppShell';

function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
      Раздел «{title}» пока недоступен.
    </div>
  );
}

function EmployeesRoute() {
  return <EmployeesPage />;
}

function EmployeeDetailRoute() {
  const id = useEmployeeRouteId();
  if (!id) return <Placeholder title="Карточка работника" />;
  return <EmployeeDetailPage id={id} />;
}

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const employeesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/employees',
  component: EmployeesRoute,
});

const employeeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/employees/$employeeId',
  component: EmployeeDetailRoute,
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  component: () => <Placeholder title="Мои задачи" />,
});

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  component: ReviewPage,
});

const reviewIgRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review-ig', component: () => <ReviewPage reviewGroup="IG" /> });
const reviewIgDocumentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review-ig/$documentId', component: () => <ReviewDocumentPage reviewGroup="IG" /> });

const reviewDocumentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review/$documentId', component: ReviewDocumentPage });
const candidatesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/candidates', component: CandidatesPage });
const candidateWorkspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review/candidates/$candidateId', component: CandidateWorkspacePage });

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: () => <Placeholder title="Оформление" />,
});

const signingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signing',
  component: () => <Placeholder title="Подписание" />,
});

const participantsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/participants',
  component: () => <Placeholder title="Участники" />,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryPage,
});

const myReviewsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my-reviews',
  component: MyReviews,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: () => <Placeholder title="Настройки" />,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  employeesRoute,
  employeeDetailRoute,
  tasksRoute,
  reviewRoute,
  reviewDocumentRoute,
  candidateWorkspaceRoute,
  candidatesRoute,
  reviewIgRoute,
  reviewIgDocumentRoute,
  historyRoute,
  myReviewsRoute,
  onboardingRoute,
  signingRoute,
  participantsRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
