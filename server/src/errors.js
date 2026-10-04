/** An error whose message is safe and useful to show to people in the activity. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.expose = true;
  }
}
