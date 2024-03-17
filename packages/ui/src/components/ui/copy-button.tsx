import { Check, Copy } from 'lucide-react';
import { Tooltip } from './tooltip-simple';
import { Button } from './button';
import { useState } from 'react';
import { cn } from '../../lib/utils';

export function CopyButtonWithTooltip({
  copyValue,
  className = '',
  size = 18,
}: {
  copyValue: string;
  className?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);

  const onClickCopy = () => {
    navigator.clipboard.writeText(copyValue).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Tooltip label={copied ? 'Copied' : 'Copy'}>
      <Button
        variant="ghost"
        className={cn('p-1 h-auto', className)}
        onClick={onClickCopy}
      >
        {copied ? <Check size={size} /> : <Copy size={size} />}
      </Button>
    </Tooltip>
  );
}
