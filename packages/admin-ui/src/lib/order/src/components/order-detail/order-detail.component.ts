import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker';
import {
    AdjustmentType,
    BaseDetailComponent,
    CustomFieldConfig,
    DataService,
    EditNoteDialogComponent,
    GetOrderHistory,
    GetOrderQuery,
    HistoryEntry,
    ModalService,
    NotificationService,
    Order,
    OrderDetail,
    OrderLineFragment,
    ServerConfigService,
    SortOrder,
} from '@vendure/admin-ui/core';
import { omit } from '@vendure/common/lib/omit';
import { EMPTY, Observable, of, Subject } from 'rxjs';
import { map, mapTo, startWith, switchMap, take } from 'rxjs/operators';

import { CancelOrderDialogComponent } from '../cancel-order-dialog/cancel-order-dialog.component';
import { FulfillOrderDialogComponent } from '../fulfill-order-dialog/fulfill-order-dialog.component';
import { OrderProcessGraphDialogComponent } from '../order-process-graph-dialog/order-process-graph-dialog.component';
import { RefundOrderDialogComponent } from '../refund-order-dialog/refund-order-dialog.component';
import { SettleRefundDialogComponent } from '../settle-refund-dialog/settle-refund-dialog.component';

@Component({
    selector: 'vdr-order-detail',
    templateUrl: './order-detail.component.html',
    styleUrls: ['./order-detail.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderDetailComponent
    extends BaseDetailComponent<OrderDetail.Fragment>
    implements OnInit, OnDestroy {
    detailForm = new FormGroup({});
    history$: Observable<GetOrderHistory.Items[] | undefined>;
    nextStates$: Observable<string[]>;
    fetchHistory = new Subject<void>();
    customFields: CustomFieldConfig[];
    orderLineCustomFields: CustomFieldConfig[];
    orderLineCustomFieldsVisible = false;
    private readonly defaultStates = [
        'AddingItems',
        'ArrangingPayment',
        'PaymentAuthorized',
        'PaymentSettled',
        'PartiallyDelivered',
        'Delivered',
        'Cancelled',
    ];
    constructor(
        router: Router,
        route: ActivatedRoute,
        serverConfigService: ServerConfigService,
        private changeDetector: ChangeDetectorRef,
        protected dataService: DataService,
        private notificationService: NotificationService,
        private modalService: ModalService,
    ) {
        super(route, router, serverConfigService, dataService);
    }

    get visibleOrderLineCustomFields(): CustomFieldConfig[] {
        return this.orderLineCustomFieldsVisible ? this.orderLineCustomFields : [];
    }

    get showElided(): boolean {
        return !this.orderLineCustomFieldsVisible && 0 < this.orderLineCustomFields.length;
    }

    ngOnInit() {
        this.init();
        this.customFields = this.getCustomFieldConfig('Order');
        this.orderLineCustomFields = this.getCustomFieldConfig('OrderLine');
        this.orderLineCustomFieldsVisible = this.orderLineCustomFields.length < 2;
        this.history$ = this.fetchHistory.pipe(
            startWith(null),
            switchMap(() => {
                return this.dataService.order
                    .getOrderHistory(this.id, {
                        sort: {
                            createdAt: SortOrder.DESC,
                        },
                    })
                    .mapStream(data => data.order?.history.items);
            }),
        );
        this.nextStates$ = this.entity$.pipe(
            map(order => {
                const isInCustomState = !this.defaultStates.includes(order.state);
                return isInCustomState
                    ? order.nextStates
                    : order.nextStates.filter(s => !this.defaultStates.includes(s));
            }),
        );
    }

    ngOnDestroy() {
        this.destroy();
    }

    toggleOrderLineCustomFields() {
        this.orderLineCustomFieldsVisible = !this.orderLineCustomFieldsVisible;
    }

    getLinePromotions(line: OrderDetail.Lines) {
        return line.adjustments.filter(a => a.type === AdjustmentType.PROMOTION);
    }

    getPromotionLink(promotion: OrderDetail.Adjustments): any[] {
        const id = promotion.adjustmentSource.split(':')[1];
        return ['/marketing', 'promotions', id];
    }

    openStateDiagram() {
        this.entity$
            .pipe(
                take(1),
                switchMap(order =>
                    this.modalService.fromComponent(OrderProcessGraphDialogComponent, {
                        closable: true,
                        locals: {
                            activeState: order.state,
                        },
                    }),
                ),
            )
            .subscribe();
    }

    transitionToState(state: string) {
        this.dataService.order.transitionToState(this.id, state).subscribe(({ transitionOrderToState }) => {
            switch (transitionOrderToState?.__typename) {
                case 'Order':
                    this.notificationService.success(_('order.transitioned-to-state-success'), { state });
                    this.fetchHistory.next();
                    break;
                case 'OrderStateTransitionError':
                    this.notificationService.error(transitionOrderToState.transitionError);
            }
        });
    }

    updateCustomFields(customFieldsValue: any) {
        this.dataService.order
            .updateOrderCustomFields({
                id: this.id,
                customFields: customFieldsValue,
            })
            .subscribe(() => {
                this.notificationService.success(_('common.notify-update-success'), { entity: 'Order' });
            });
    }

    getCouponCodeForAdjustment(
        order: OrderDetail.Fragment,
        promotionAdjustment: OrderDetail.Adjustments,
    ): string | undefined {
        const id = promotionAdjustment.adjustmentSource.split(':')[1];
        const promotion = order.promotions.find(p => p.id === id);
        if (promotion) {
            return promotion.couponCode || undefined;
        }
    }

    getOrderAddressLines(orderAddress?: { [key: string]: string }): string[] {
        if (!orderAddress) {
            return [];
        }
        return Object.values(orderAddress)
            .filter(val => val !== 'OrderAddress')
            .filter(line => !!line);
    }

    settlePayment(payment: OrderDetail.Payments) {
        this.dataService.order.settlePayment(payment.id).subscribe(({ settlePayment }) => {
            switch (settlePayment.__typename) {
                case 'Payment':
                    if (settlePayment.state === 'Settled') {
                        this.notificationService.success(_('order.settle-payment-success'));
                    } else {
                        this.notificationService.error(_('order.settle-payment-error'));
                    }
                    this.dataService.order.getOrder(this.id).single$.subscribe();
                    this.fetchHistory.next();
                    break;
                case 'OrderStateTransitionError':
                case 'PaymentStateTransitionError':
                case 'SettlePaymentError':
                    this.notificationService.error(settlePayment.message);
            }
        });
    }

    canAddFulfillment(order: OrderDetail.Fragment): boolean {
        const allItemsFulfilled = order.lines
            .reduce((items, line) => [...items, ...line.items], [] as OrderLineFragment['items'])
            .every(item => !!item.fulfillment);
        return (
            !allItemsFulfilled &&
            (order.nextStates.includes('Shipped') || order.nextStates.includes('PartiallyShipped'))
        );
    }

    fulfillOrder() {
        this.entity$
            .pipe(
                take(1),
                switchMap(order => {
                    return this.modalService.fromComponent(FulfillOrderDialogComponent, {
                        size: 'xl',
                        locals: {
                            order,
                        },
                    });
                }),
                switchMap(input => {
                    if (input) {
                        return this.dataService.order.createFulfillment(input);
                    } else {
                        return of(undefined);
                    }
                }),
                switchMap(result => this.refetchOrder(result).pipe(mapTo(result))),
            )
            .subscribe(result => {
                if (result) {
                    switch (result.addFulfillmentToOrder.__typename) {
                        case 'Fulfillment':
                            this.notificationService.success(_('order.create-fulfillment-success'));
                            break;
                        case 'EmptyOrderLineSelectionError':
                        case 'InsufficientStockOnHandError':
                        case 'ItemsAlreadyFulfilledError':
                            this.notificationService.error(result.addFulfillmentToOrder.message);
                            break;
                    }
                }
            });
    }

    transitionFulfillment(id: string, state: string) {
        this.dataService.order
            .transitionFulfillmentToState(id, state)
            .pipe(switchMap(result => this.refetchOrder(result)))
            .subscribe(() => {
                this.notificationService.success(_('order.successfully-updated-fulfillment'));
            });
    }

    cancelOrRefund(order: OrderDetail.Fragment) {
        const isRefundable = this.orderHasSettledPayments(order);
        if (order.state === 'PaymentAuthorized' || order.active === true || !isRefundable) {
            this.cancelOrder(order);
        } else {
            this.refundOrder(order);
        }
    }

    settleRefund(refund: OrderDetail.Refunds) {
        this.modalService
            .fromComponent(SettleRefundDialogComponent, {
                size: 'md',
                locals: {
                    refund,
                },
            })
            .pipe(
                switchMap(transactionId => {
                    if (transactionId) {
                        return this.dataService.order.settleRefund(
                            {
                                transactionId,
                                id: refund.id,
                            },
                            this.id,
                        );
                    } else {
                        return of(undefined);
                    }
                }),
                // switchMap(result => this.refetchOrder(result)),
            )
            .subscribe(result => {
                if (result) {
                    this.notificationService.success(_('order.settle-refund-success'));
                }
            });
    }

    addNote(event: { note: string; isPublic: boolean }) {
        const { note, isPublic } = event;
        this.dataService.order
            .addNoteToOrder({
                id: this.id,
                note,
                isPublic,
            })
            .pipe(switchMap(result => this.refetchOrder(result)))
            .subscribe(result => {
                this.notificationService.success(_('common.notify-create-success'), {
                    entity: 'Note',
                });
            });
    }

    updateNote(entry: HistoryEntry) {
        this.modalService
            .fromComponent(EditNoteDialogComponent, {
                closable: true,
                locals: {
                    displayPrivacyControls: true,
                    note: entry.data.note,
                    noteIsPrivate: !entry.isPublic,
                },
            })
            .pipe(
                switchMap(result => {
                    if (result) {
                        return this.dataService.order.updateOrderNote({
                            noteId: entry.id,
                            isPublic: !result.isPrivate,
                            note: result.note,
                        });
                    } else {
                        return EMPTY;
                    }
                }),
            )
            .subscribe(result => {
                this.fetchHistory.next();
                this.notificationService.success(_('common.notify-update-success'), {
                    entity: 'Note',
                });
            });
    }

    deleteNote(entry: HistoryEntry) {
        return this.modalService
            .dialog({
                title: _('common.confirm-delete-note'),
                body: entry.data.note,
                buttons: [
                    { type: 'secondary', label: _('common.cancel') },
                    { type: 'danger', label: _('common.delete'), returnValue: true },
                ],
            })
            .pipe(switchMap(res => (res ? this.dataService.order.deleteOrderNote(entry.id) : EMPTY)))
            .subscribe(() => {
                this.fetchHistory.next();
                this.notificationService.success(_('common.notify-delete-success'), {
                    entity: 'Note',
                });
            });
    }

    orderHasSettledPayments(order: OrderDetail.Fragment): boolean {
        return !!order.payments?.find(p => p.state === 'Settled');
    }

    private cancelOrder(order: OrderDetail.Fragment) {
        this.modalService
            .fromComponent(CancelOrderDialogComponent, {
                size: 'xl',
                locals: {
                    order,
                },
            })
            .pipe(
                switchMap(input => {
                    if (input) {
                        return this.dataService.order.cancelOrder(input);
                    } else {
                        return of(undefined);
                    }
                }),
                switchMap(result => this.refetchOrder(result)),
            )
            .subscribe(result => {
                if (result) {
                    this.notificationService.success(_('order.cancelled-order-success'));
                }
            });
    }

    private refundOrder(order: OrderDetail.Fragment) {
        this.modalService
            .fromComponent(RefundOrderDialogComponent, {
                size: 'xl',
                locals: {
                    order,
                },
            })
            .pipe(
                switchMap(input => {
                    if (input) {
                        return this.dataService.order.refundOrder(omit(input, ['cancel'])).pipe(
                            switchMap(({ refundOrder }) => {
                                switch (refundOrder.__typename) {
                                    case 'Refund':
                                        if (input.cancel.length) {
                                            return this.dataService.order
                                                .cancelOrder({
                                                    orderId: this.id,
                                                    lines: input.cancel,
                                                    reason: input.reason,
                                                })
                                                .pipe(map(({ cancelOrder }) => cancelOrder));
                                        } else {
                                            return of(refundOrder);
                                        }
                                    case 'AlreadyRefundedError':
                                    case 'OrderStateTransitionError':
                                    case 'MultipleOrderError':
                                    case 'NothingToRefundError':
                                    case 'PaymentOrderMismatchError':
                                    case 'QuantityTooGreatError':
                                    case 'RefundOrderStateError':
                                    case 'RefundStateTransitionError':
                                        this.notificationService.error(refundOrder.message);
                                    // tslint:disable-next-line:no-switch-case-fall-through
                                    default:
                                        return of(undefined);
                                }
                            }),
                        );
                    } else {
                        return of(undefined);
                    }
                }),
            )
            .subscribe(result => {
                if (result) {
                    switch (result.__typename) {
                        case 'Order':
                        case 'Refund':
                            this.refetchOrder(result).subscribe();
                            this.notificationService.success(_('order.refund-order-success'));
                            break;
                        case 'QuantityTooGreatError':
                        case 'MultipleOrderError':
                        case 'OrderStateTransitionError':
                        case 'CancelActiveOrderError':
                        case 'EmptyOrderLineSelectionError':
                            this.notificationService.error(result.message);
                    }
                }
            });
    }

    private refetchOrder(result: object | undefined): Observable<GetOrderQuery | undefined> {
        this.fetchHistory.next();
        if (result) {
            return this.dataService.order.getOrder(this.id).single$;
        } else {
            return of(undefined);
        }
    }

    protected setFormValues(entity: Order.Fragment): void {
        // empty
    }
}
