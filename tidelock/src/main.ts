// TIDELOCK entry point. The error panel is installed first (import order matters): it is how bugs get reported.
import { showFatal } from './app/errors';
import { boot } from './app/app';

boot().catch((err) => showFatal(err, 'boot'));
