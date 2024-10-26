import { NotificationService, Logger, OrderService } from "medusa-interfaces";
import { humanizeAmount, zeroDecimalCurrencies } from "medusa-core-utils";
import nodemailer from "nodemailer";
const hbs = require("nodemailer-express-handlebars");

interface EmailConfig {
	fromAddress: string;
	transport: Object;
	templatesDir: string;
	layoutsDir: string;
	partialsDir: string;
	defaultLayout: string | boolean;
	templateMap: Object;
	hbsHelpers: Object;
}

class EmailSenderService extends NotificationService {
	static identifier = "email_sender";
	static is_installed = true;

	protected orderService: OrderService;
	protected cartService: any;
	protected lineItemService: any;
	protected logger: Logger;
	protected config: EmailConfig;
	protected transporter: any;

	constructor(container: any, options: EmailConfig) {
		super();
		this.orderService = container.orderService;
		this.cartService = container.cartService;
		this.lineItemService = container.lineItemService;
		this.logger = container.logger;

		const defaultTemplatesDir =
			"node_modules/@lumot-eu/medusa-plugin-nodemailer/email-templates";

		this.config = {
			fromAddress: "noreply@medusajs.com",
			transport: {
				sendmail: true,
				path: "/usr/sbin/sendmail",
				newline: "unix",
			},
			templatesDir: defaultTemplatesDir,
			layoutsDir: `${defaultTemplatesDir}/_layouts`,
			partialsDir: `${defaultTemplatesDir}/_partials`,
			defaultLayout: "default.hbs",
			templateMap: {
				"order.placed": {
					name: "order.placed",
					subject: "Order confirmation",
				},
			},
			hbsHelpers: {},
			...options,
		};

		this.transporter = nodemailer.createTransport(this.config.transport);

		this.logger.info("[plugin-nodemailer] EmailSender service initialized.");
	}

	async sendNotification(
		eventName: string,
		eventData: any,
		attachmentGenerator: unknown
	): Promise<{
		to: string;
		status: string;
		data: Record<string, unknown>;
	}> {
		const template = this.config.templateMap[eventName] || null;
		if (!template?.name) {
			return {
				to: "",
				status: "noTemplateFound",
				data: {},
			};
		}

		const templateData = await this.fetchData(eventName, eventData);
		const to = templateData.to;

		await this.sendEmail(to, template.subject, template.name, templateData);

		return {
			to: to,
			data: templateData,
			status: "sent",
		};
	}

	async resendNotification(
		notification: any,
		config: any,
		attachmentGenerator: unknown
	): Promise<{ to: string; status: string; data: Record<string, unknown> }> {
		const template = this.config.templateMap[notification.event_name] || null;
		if (!template?.name) {
			return {
				to: notification.to,
				status: "noTemplateFound",
				data: notification.data,
			};
		}

		// check if the receiver should be changed
		const to: string = config.to || notification.to;

		const templateData = notification.data || {};

		await this.sendEmail(to, template.subject, template.name, templateData);

		return {
			to: to,
			status: "sent",
			data: templateData,
		};
	}

	async sendEmail(
		toAddress: string,
		subject: string,
		templateName: string,
		templateData: any
	): Promise<void> {
		// Set Handlebars as template engine
		this.transporter.use(
			"compile",
			hbs({
				viewEngine: {
					layoutsDir: this.config.layoutsDir,
					partialsDir: this.config.partialsDir,
					defaultLayout: this.config.defaultLayout,
					extname: ".hbs",
					helpers: this.config.hbsHelpers,
				},
				viewPath: this.config.templatesDir,
				extName: ".hbs",
			})
		);

		this.logger.info(
			`[plugin-nodemailer] Sending an email to '${toAddress}' using the "${templateName}" template.`
		);

		await this.transporter.sendMail({
			from: this.config.fromAddress,
			to: toAddress,
			subject: subject,
			template: `${templateName}/html`,
			text_template: `${templateName}/txt`,
			context: templateData,
		});
	}

	async fetchData(eventName: string, eventData: any) {
		switch (true) {
			case eventName.includes("order."): {
				const priceFields = [
					"shipping_total",
					"discount_total",
					"tax_total",
					"refunded_total",
					"gift_card_total",
					"subtotal",
					"total",
				];

				const order = await this.orderService.retrieve(eventData.id, {
					select: [...priceFields],
					relations: [
						"refunds",
						"items",
						"customer",
						"billing_address",
						"shipping_address",
						"discounts",
						"discounts.rule",
						"shipping_methods",
						"shipping_methods.shipping_option",
						"payments",
						"fulfillments",
						"fulfillments.tracking_links",
						"returns",
						"gift_cards",
						"gift_card_transactions",
					],
				});

				priceFields.forEach((key) => {
					order[`${key}_formatted`] = this.formatPrice(
						order[key],
						order.currency_code
					);
				});

				order.reference = order.id.replace("order_", "");
				order.items = order.items.map((item) => {
					const { unit_price, total } = item;
					const { currency_code } = order;

					return {
						...item,
						unit_price_formatted: this.formatPrice(unit_price, currency_code),
						total_formatted: this.formatPrice(total, currency_code),
					};
				});

				return {
					to: order.email,
					order,
				};
			}
			case eventName.includes("customer."): {
				return {
					to: eventData?.customer?.email || eventData?.email,
					...eventData,
				};
			}
			case eventName === "invite.created": {
				return {
					to: eventData.user_email,
					...eventData,
				};
			}
			case eventName === "user.password_reset": {
				return {
					to: eventData.email,
					...eventData,
				};
			}
			default: {
				return eventData;
			}
		}
	}

	formatPrice(amount: number, currency_code: string) {
		const decimalPlaces = zeroDecimalCurrencies.includes(
			currency_code.toLowerCase()
		)
			? 0
			: 2;
		const formattedAmount = amount
			? humanizeAmount(amount, currency_code).toFixed(decimalPlaces)
			: "0.00";

		const currencySigns: Record<string, string> = {
			eur: "€",
			usd: "$",
		};

		const currencySymbol =
			currencySigns[currency_code.toLowerCase()] || currency_code;

		return `${formattedAmount} ${currencySymbol}`;
	}
}

export default EmailSenderService;
