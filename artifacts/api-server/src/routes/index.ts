import { Router, type IRouter } from "express";
import authRouter from "./auth";
import calendarRouter from "./calendar";
import dashboardRouter from "./dashboard";
import healthRouter from "./health";
import importsRouter from "./imports";
import attachmentsRouter from "./attachments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(calendarRouter);
router.use(dashboardRouter);
router.use(importsRouter);
router.use(attachmentsRouter);

export default router;
