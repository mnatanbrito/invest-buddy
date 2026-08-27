import { ChevronDownIcon, ChevronUpIcon, MoreVerticalIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface EntityActionsMenuProps {
  /** e.g. "RRSP" — used only to compose the trigger's aria-label. */
  entityLabel: string;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * The move/edit/delete menu shared by account, sleeve, and asset rows.
 * Edit and delete open dialogs owned by the caller. Radix returns focus to
 * the trigger as the menu closes, which races the dialog's own mount and can
 * misplace focus — `onCloseAutoFocus` on the content (not `preventDefault`
 * on the items' `onSelect`, which would stop the menu from closing at all)
 * is Radix's documented way to skip that auto-focus step.
 */
export function EntityActionsMenu({
  entityLabel,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: EntityActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${entityLabel}`}>
          <MoreVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem disabled={isFirst} onSelect={onMoveUp}>
          <ChevronUpIcon />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isLast} onSelect={onMoveDown}>
          <ChevronDownIcon />
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <PencilIcon />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
