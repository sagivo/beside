import { AlertTriangle, RefreshCcw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';

export function ErrorView({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Something went wrong"
        description="Don't worry, your memory is safe. Try again or open Help."
      />
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Renderer error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
      <div>
        <Button onClick={onRetry}>
          <RefreshCcw />
          Try again
        </Button>
      </div>
    </div>
  );
}
