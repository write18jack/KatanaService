import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";

type FormErrorProps = {
  title: string;
  message: string | undefined;
};

export const FormError = ({ title, message }: FormErrorProps) => {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <ExclamationTriangleIcon className="h-3 w-3" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
};
