import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import webRouter from "./web";

const router: IRouter = Router();

router.use("/healthz", healthRouter);
router.use("/ai", aiRouter);
router.use("/web", webRouter);

export default router;
