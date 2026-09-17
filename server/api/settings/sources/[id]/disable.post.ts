import { defineEventHandler } from "h3";
import { setSourceEnabled } from "../../../../utils/sourceActions";

export default defineEventHandler((event) => setSourceEnabled(event, false));
