import Twilio from 'twilio';
import { env } from '../config/env';

// Single Twilio SDK client. Exported for the gateway implementation only —
// the rest of the app uses the gateway interface (twilio/gateway.ts).
export const twilioClient = Twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
