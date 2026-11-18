/** Every user-visible text of the app, in one place. */
export const strings = {
  appName: 'SubTrack',

  titleCreate: 'Add subscription',
  titleUpdate: 'Edit subscription',
  back: 'Back',

  // List
  monthlyTotal: 'Monthly total',
  activeSubscriptions: (active: number, total: number) => `${active} of ${total} active`,
  emptyState: 'No subscriptions yet.\nTap + to add your first one.',
  addSubscription: 'Add subscription',
  itemDetails: (cycle: string, due: string) => `${cycle} • ${due}`,
  dueToday: 'due today',
  dueTomorrow: 'due tomorrow',
  dueInDays: (days: number) => (days === 1 ? 'due in 1 day' : `due in ${days} days`),
  overdue: 'overdue',
  paused: 'Paused',
  swipeDelete: 'Delete',

  // Theme
  actionTheme: 'Theme',
  themeSystem: 'System default',
  themeLight: 'Light',
  themeDark: 'Dark',

  // Form labels
  labelName: 'Name',
  labelAmount: 'Amount',
  labelCurrency: 'Currency',
  labelBillingCycle: 'Billing cycle',
  labelNextPayment: 'Next payment date',
  labelCategory: 'Category',
  labelActive: 'Active',
  labelActiveHint: 'Paused subscriptions are not counted in the monthly total',
  labelNotes: 'Notes (optional)',
  labelTags: 'Tags',
  labelSharedWith: 'Shared with',
  labelSharedWithHint: 'How many other people share this subscription',
  labelPayments: 'Payment history',
  sharedWithValue: (count: number) => (count === 1 ? '1 person' : `${count} people`),
  decreaseSharedWith: 'Share with one person less',
  increaseSharedWith: 'Share with one person more',
  placeholderTag: 'Add a tag, e.g. family',
  addTag: 'Add',
  removeTag: (tag: string) => `Remove tag ${tag}`,
  markAsPaid: 'Mark as paid today',
  noPayments: 'No payments recorded yet.',
  paymentLine: (date: string, amount: string) => `${date} · ${amount}`,
  morePayments: (count: number) => (count === 1 ? '1 older payment' : `${count} older payments`),

  placeholderName: 'e.g. Netflix',
  placeholderAmount: '0.00',
  placeholderDate: 'Select a date',
  placeholderNotes: 'e.g. shared with my sister',
  pickDate: 'Pick a date',
  done: 'Done',

  // Actions
  actionCreate: 'Add subscription',
  actionUpdate: 'Save changes',
  actionDelete: 'Delete subscription',
  delete: 'Delete',
  cancel: 'Cancel',

  // Delete dialog
  deleteTitle: (name: string) => `Delete ${name}?`,
  deleteMessage: 'This cannot be undone.',

  // Validation
  errorNameRequired: 'Name is required',
  errorNameTooLong: (max: number) => `Name must be at most ${max} characters`,
  errorAmountRequired: 'Amount is required',
  errorAmountInvalid: 'Enter a valid number, e.g. 49.99',
  errorAmountPositive: 'Amount must be greater than 0',
  errorAmountDecimals: 'Use at most 2 decimals',
  errorDateRequired: 'Choose the next payment date',
  errorTagRequired: 'Type a tag first',
  errorTagTooLong: (max: number) => `A tag can have at most ${max} characters`,
  errorTagDuplicate: 'This tag is already added',
  errorTooManyTags: (max: number) => `At most ${max} tags`,
  errorPaymentAmount: 'Enter a valid amount before marking it as paid',

  // Persistence errors (the reason is shown on a second line)
  errorLoad: 'Could not load your subscriptions.',
  errorCreate: 'Could not save the subscription.',
  errorUpdate: 'Could not save the changes.',
  errorDelete: 'Could not delete the subscription.',
  errorSync: 'Some changes could not be synced.',
  errorNotFound: 'This subscription no longer exists. It may have been deleted on another device.',
  errorNetwork: 'The server cannot be reached. Check your connection and try again.',
  errorRejected: 'The server did not accept these values. Check the form and try again.',
  errorRejectedFields: (fields: string) => `The server did not accept these values: ${fields}.`,
  errorServer: 'The server ran into a problem. Please try again in a moment.',
  errorStorage: 'Your phone could not access the saved data. Please try again.',
  retry: 'Retry',
  loading: 'Loading subscriptions…',

  // Server sync
  offlineBanner: 'Offline – changes will sync when you’re back online',
  connecting: 'Connecting to the server…',
  syncing: 'Syncing…',
  lastSynced: (when: string) => `Last synced: ${when}`,
  neverSynced: 'Not synced yet',
  pendingChanges: (count: number) => (count === 1 ? '1 change waiting to sync' : `${count} changes waiting to sync`),
  notSynced: 'Not synced',
  today: 'today',
  yesterday: 'yesterday',

  // Events
  eventCreated: (name: string) => `Added ${name}`,
  eventUpdated: (name: string) => `Saved changes to ${name}`,
  eventDeleted: (name: string) => `Deleted ${name}`,
  eventOffline: (message: string) => `${message} – will sync when online`,
  eventRemoteCreated: (name: string) => `${name} was added on another device`,
  eventRemoteUpdated: (name: string) => `${name} was changed on another device`,
  eventRemoteDeleted: (name: string) => `${name} was deleted on another device`,
};
