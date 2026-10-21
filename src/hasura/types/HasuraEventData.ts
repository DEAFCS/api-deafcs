export type HasuraEventData<T> = {
  op: "INSERT" | "UPDATE" | "DELETE";
  old: T;
  new: T;
  // DEAFCS: when Hasura recorded the change (its event's created_at, UTC). A
  // retried or late delivery keeps it.
  created_at?: string;
};
